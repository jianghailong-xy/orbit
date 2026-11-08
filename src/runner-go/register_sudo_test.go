package main

import (
	"errors"
	"io"
	"os"
	"os/user"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// Who a command run through sudo is handed to: the account SUDO_USER names, and only when this process
// is root and that account is not. Root's own login keeps root's runner.
func TestSudoAccountIsTheAccountThatRanSudo(t *testing.T) {
	c2b := &user.User{Uid: "4242", Gid: "4242", Username: "c2b", HomeDir: "/home/c2b"}
	toor := &user.User{Uid: "0", Gid: "0", Username: "toor", HomeDir: "/root"}
	prevEUID, prevLookup, prevKnown := processEUID, lookupUser, accountKnownToSystem
	t.Cleanup(func() { processEUID, lookupUser, accountKnownToSystem = prevEUID, prevLookup, prevKnown })
	lookupUser = func(name string) (*user.User, error) {
		switch name {
		case "c2b":
			return c2b, nil
		case "toor":
			return toor, nil
		}
		return nil, errors.New("no such account")
	}
	accountKnownToSystem = func(name string) bool { return name == "ldap-user" }
	for _, tc := range []struct {
		name, sudoUser, want string
		euid                 int
	}{
		{"root under sudo from c2b", "c2b", "c2b", 0},
		{"c2b itself, as sudo -u c2b leaves it", "root", "", 4242},
		{"c2b, not under sudo", "", "", 4242},
		{"root's own login", "", "", 0},
		{"sudo run by root", "root", "", 0},
		// An LDAP or SSSD account a release build cannot look up: sudo can switch to it by name.
		{"an account only the system can look up", "ldap-user", "ldap-user", 0},
		// A SUDO_USER a shell or an image inherited.
		{"an account the system does not know", "ghost", "", 0},
		{"another name for root", "toor", "", 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("SUDO_USER", tc.sudoUser)
			processEUID = func() int { return tc.euid }
			got, ok := sudoAccount()
			if tc.want == "" {
				if ok {
					t.Fatalf("sudoAccount() = %v, want no hand-off", got)
				}
				return
			}
			if !ok || got.Username != tc.want {
				t.Fatalf("sudoAccount() = %v, %v; want %s", got, ok, tc.want)
			}
		})
	}
}

// The account's command gets what register reads and nothing else of root's environment. Through sudo's
// environment and -E: a proxy's URL can hold a password, and sudo logs what is on its command line and
// what --preserve-env names.
func TestSudoHandOffCarriesWhatRegisterReads(t *testing.T) {
	for _, k := range sudoHandOffEnv {
		t.Setenv(k, "")
		os.Unsetenv(k)
	}
	t.Setenv("ORBIT_HOME", "/srv/orbit-c2b")
	t.Setenv("https_proxy", "http://user:secret@proxy.internal:3128")
	t.Setenv("SSL_CERT_FILE", "/etc/orbit/ca.pem")
	t.Setenv("TERM", "xterm")
	t.Setenv("PATH", "/usr/bin:/bin")
	t.Setenv("ORBIT_SESSION_ID", "not-carried")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "not-carried")

	got := sudoHandOffArgv("/usr/bin/sudo", "c2b", "/usr/local/bin/orbit", []string{"register", "--name", "c2b-load-2"})
	want := []string{"/usr/bin/sudo", "-E", "-H", "-u", "c2b", "--", "/usr/local/bin/orbit", "register", "--name", "c2b-load-2"}
	if !slices.Equal(got, want) {
		t.Fatalf("sudoHandOffArgv =\n  %q\nwant\n  %q", got, want)
	}
	env := sudoHandOffEnviron()
	for _, kv := range []string{sudoHandOffMark + "=1", "ORBIT_HOME=/srv/orbit-c2b", "https_proxy=http://user:secret@proxy.internal:3128", "SSL_CERT_FILE=/etc/orbit/ca.pem", "TERM=xterm", "PATH=/usr/bin:/bin"} {
		if !slices.Contains(env, kv) {
			t.Errorf("the hand-off's environment lacks %s: %q", kv, env)
		}
	}
	for _, kv := range env {
		if strings.Contains(kv, "not-carried") {
			t.Errorf("the hand-off carries %s of root's environment", kv)
		}
	}
}

// The system's own answer, for accounts every machine has.
func TestAccountKnownToSystemAsksTheSystem(t *testing.T) {
	for name, want := range map[string]bool{"nobody": true, "root": false, "no-such-account-34pvv": false} {
		if got := accountKnownToSystem(name); got != want {
			t.Errorf("accountKnownToSystem(%s) = %v, want %v", name, got, want)
		}
	}
}

// A hand-off is what asked for a running service with root in hand, install.sh's included. Root's own
// `sudo -u svc orbit register` may be a script that supervises `orbit run` itself.
func TestHandedOffBySudoIsOnlyTheHandOff(t *testing.T) {
	prevEUID := processEUID
	t.Cleanup(func() { processEUID = prevEUID })
	for _, tc := range []struct {
		name, sudoUser, mark, plan string
		euid                       int
		want                       bool
	}{
		{"this hand-off", "root", "1", "", 4242, true},
		{"install.sh's", "root", "", "1", 4242, true},
		{"root's own sudo -u svc", "root", "", "", 4242, false},
		{"install.sh with no sudo", "", "", "1", 4242, false},
		{"root itself", "root", "1", "", 0, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("SUDO_USER", tc.sudoUser)
			t.Setenv(sudoHandOffMark, tc.mark)
			t.Setenv("ORBIT_INSTALL_PLAN", tc.plan)
			processEUID = func() int { return tc.euid }
			if got := handedOffBySudo(); got != tc.want {
				t.Fatalf("handedOffBySudo() = %v, want %v", got, tc.want)
			}
		})
	}
}

// What counts as a runner an older `sudo orbit register` left in root's home. On Linux the account's unit
// says so. A Mac cannot tell it from a runner of root's own, so an account that has a runner of its own is
// asking about that one.
func TestRunnerLeftInRootsHome(t *testing.T) {
	account := &user.User{Username: "c2b", HomeDir: t.TempDir()}
	root := &user.User{Username: "root", HomeDir: t.TempDir()}
	prevDir := serviceUnitDir
	t.Cleanup(func() { serviceUnitDir = prevDir })
	serviceUnitDir = t.TempDir()
	unit := filepath.Join(serviceUnitDir, "orbit-runner-c2b.service")
	write := func(path, content string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	check := func(what string, goos string, want bool) {
		t.Helper()
		if got := runnerLeftInRootsHome(goos, account, root); got != want {
			t.Errorf("%s on %s: runnerLeftInRootsHome = %v, want %v", what, goos, got, want)
		}
	}
	rootOrbit := filepath.Join(root.HomeDir, ".orbit")

	write(unit, renderSystemdUnit("c2b", "c2b", "/x/orbit", account.HomeDir, rootOrbit, "/usr/bin", nil))
	check("the old unit, and no config in root's home", "linux", false)
	write(launchAgentPath(root.HomeDir), "")
	check("root's agent, and no config in root's home", "darwin", false)

	write(filepath.Join(rootOrbit, "config.json"), "{}")
	check("the old unit and a config in root's home", "linux", true)
	check("root's agent and a config in root's home", "darwin", true)

	write(unit, renderSystemdUnit("c2b", "c2b", "/x/orbit", account.HomeDir, filepath.Join(account.HomeDir, ".orbit"), "/usr/bin", nil))
	check("a unit with the account's own home", "linux", false)

	write(filepath.Join(account.HomeDir, ".orbit", "config.json"), "{}")
	check("an account with a runner of its own", "darwin", false)
	check("any machine else", "freebsd", false)
}

// Whose runner a registration is: under sudo that made this process root, the account that ran sudo. Under
// `sudo -u svc` the process is svc and SUDO_USER is whoever typed it: the config is svc's, so the service
// has to be too. Naming the unit after SUDO_USER there gave it another account's ORBIT_HOME, the mismatch
// `sudo -i` has with root's.
func TestRegisteringUserIsTheAccountTheRunnerBelongsTo(t *testing.T) {
	c2b := &user.User{Uid: "4242", Gid: "4242", Username: "c2b", HomeDir: "/home/c2b"}
	svc := &user.User{Uid: "4343", Gid: "4343", Username: "svc", HomeDir: "/home/svc"}
	root := &user.User{Uid: "0", Gid: "0", Username: "root", HomeDir: "/root"}
	prevEUID, prevLookup, prevCurrent := processEUID, lookupUser, currentUser
	t.Cleanup(func() { processEUID, lookupUser, currentUser = prevEUID, prevLookup, prevCurrent })
	lookupUser = func(name string) (*user.User, error) {
		if name == "c2b" {
			return c2b, nil
		}
		return nil, errors.New("no such account")
	}
	for _, tc := range []struct {
		name, sudoUser string
		current, want  *user.User
		euid           int
	}{
		{"sudo -i from c2b", "c2b", root, c2b, 0},
		{"sudo -u svc from c2b", "c2b", svc, svc, 4343},
		{"svc on its own", "", svc, svc, 4343},
		{"root's own login", "", root, root, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("SUDO_USER", tc.sudoUser)
			processEUID = func() int { return tc.euid }
			currentUser = func() (*user.User, error) { return tc.current, nil }
			got, err := registeringUser()
			if err != nil || got != tc.want {
				t.Fatalf("registeringUser() = %v, %v; want %v", got, err, tc.want)
			}
		})
	}
}

// The hand-off runs what it finds as root. Where sudo keeps PATH, PATH is the account's, so an agent of the
// account could put a sudo of its own first on it: the hand-off looks only in the system's own directories.
func TestHandOffRunsTheSystemsSudoNotOneOnPath(t *testing.T) {
	system, planted := t.TempDir(), t.TempDir()
	for _, dir := range []string{system, planted} {
		if err := os.WriteFile(filepath.Join(dir, "sudo"), []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", planted+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("SUDO_USER", "c2b")
	account := &user.User{Uid: "4242", Gid: "4242", Username: "c2b", HomeDir: t.TempDir()}
	prevEUID, prevLookup, prevExec, prevDirs, prevCanRun := processEUID, lookupUser, execSudoHandOff, sudoSearchDirs, accountCanRun
	t.Cleanup(func() {
		processEUID, lookupUser, execSudoHandOff, sudoSearchDirs, accountCanRun = prevEUID, prevLookup, prevExec, prevDirs, prevCanRun
	})
	processEUID = func() int { return 0 }
	lookupUser = func(string) (*user.User, error) { return account, nil }
	accountCanRun = func(*user.User, string) (bool, error) { return true, nil }
	sudoSearchDirs = []string{filepath.Join(system, "absent"), system}
	var ran string
	execSudoHandOff = func(argv []string) error { ran = argv[0]; return nil }

	captureServiceOutput(t, func() {
		if !handOffUnderSudo([]string{"register", "--name", "c2b-load-2"}) {
			t.Error("register under sudo was not handed off")
		}
	})
	if want := filepath.Join(system, "sudo"); ran != want {
		t.Fatalf("the hand-off ran %s, want the system's %s", ran, want)
	}

	// A runner of root's own stays put, and the hand-off says so and how to reach it.
	rootHome := t.TempDir()
	if err := os.MkdirAll(filepath.Join(rootHome, ".orbit"), 0o700); err != nil {
		t.Fatal(err)
	}
	rootConfig := filepath.Join(rootHome, ".orbit", "config.json")
	if err := os.WriteFile(rootConfig, []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	lookupUser = func(name string) (*user.User, error) {
		if name == "root" {
			return &user.User{Uid: "0", Username: "root", HomeDir: rootHome}, nil
		}
		return account, nil
	}
	out := captureServiceOutput(t, func() { handOffUnderSudo([]string{"unregister", "--yes"}) })
	if want := "note: root's home holds a runner's config too, " + rootConfig + ", which this leaves as it is. For that runner: sudo -i env -u SUDO_USER orbit unregister"; !strings.Contains(out, want) {
		t.Errorf("the hand-off printed:\n%s\nwant %q", out, want)
	}

	sudoSearchDirs = []string{filepath.Join(system, "absent")}
	if _, err := systemSudo(); err == nil || !strings.Contains(err.Error(), "no sudo in "+sudoSearchDirs[0]) {
		t.Fatalf("systemSudo() with none there = %v", err)
	}
}

// What main put on PATH for root's own commands stays behind: root's engine directories, and Orbit's ripgrep
// directory in root's runner home, an older pin's as well as the current one. Where sudo keeps PATH they would
// reach the account's command, and its register would bake them into its service's PATH. Everything else goes
// on in its order, the account's own engine and ripgrep directories included.
func TestSudoHandOffLeavesRootsOwnDirectoriesBehind(t *testing.T) {
	rootHome, accountHome, system := t.TempDir(), t.TempDir(), t.TempDir()
	if err := os.WriteFile(filepath.Join(system, "sudo"), []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	account := &user.User{Uid: "4242", Gid: "4242", Username: "c2b", HomeDir: accountHome}
	prevEUID, prevLookup, prevExec, prevDirs, prevCanRun := processEUID, lookupUser, execSudoHandOff, sudoSearchDirs, accountCanRun
	t.Cleanup(func() {
		processEUID, lookupUser, execSudoHandOff, sudoSearchDirs, accountCanRun = prevEUID, prevLookup, prevExec, prevDirs, prevCanRun
	})
	processEUID = func() int { return 0 }
	lookupUser = func(name string) (*user.User, error) {
		if name == "root" {
			return &user.User{Uid: "0", Username: "root", HomeDir: rootHome}, nil
		}
		return account, nil
	}
	accountCanRun = func(*user.User, string) (bool, error) { return true, nil }
	sudoSearchDirs = []string{system}
	var handed string
	execSudoHandOff = func([]string) error { handed = envValue(sudoHandOffEnviron(), "PATH"); return nil }

	// Root under `sudo -i`, from a shell of the account's own runner whose PATH sudo kept.
	t.Setenv("SUDO_USER", "c2b")
	t.Setenv("HOME", rootHome)
	t.Setenv("ORBIT_HOME", "")
	os.Unsetenv("ORBIT_HOME")
	accounts := []string{
		filepath.Join(accountHome, ".local", "bin"), "/usr/bin", "/bin",
		filepath.Join(accountHome, ".orbit", "tools", "ripgrep", managedRgVersion),
	}
	rootRg := filepath.Join(rootHome, ".orbit", "tools", "ripgrep")
	path := append(engineInstallerDirs(rootHome), filepath.Join(rootRg, "14.1.1"))
	path = append(append(path, accounts...), filepath.Join(rootRg, managedRgVersion))
	t.Setenv("PATH", strings.Join(path, ":"))

	captureServiceOutput(t, func() {
		if !handOffUnderSudo([]string{"register", "--name", "c2b-load-2"}) {
			t.Error("register under sudo was not handed off")
		}
	})
	if want := strings.Join(accounts, ":"); handed != want {
		t.Fatalf("the hand-off gave the account PATH=%s\nwant PATH=%s", handed, want)
	}
}

// `sudo -i` leaves a handed-off register in /root, which the account cannot enter and its runner's
// directory probe would still report as a folder that exists: such a directory is not said at all.
func TestRegisterCwdLeavesOutADirectoryThisAccountCannotEnter(t *testing.T) {
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	wd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(dir); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chdir(wd) })
	if got := registerCwd(); got != dir {
		t.Fatalf("registerCwd() = %q, want the directory it runs in, %q", got, dir)
	}
	if os.Geteuid() == 0 {
		t.Skip("root enters any directory; only an account is refused")
	}
	if err := os.Chmod(dir, 0); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0o700) })
	if got := registerCwd(); got != "" {
		t.Fatalf("registerCwd() = %q in a directory this account cannot enter, want nothing", got)
	}
}

// captureServiceOutput collects both streams fn writes to. The register path prints its
// result to stdout and its reasons to stderr, and reading only one of them would miss
// half of what the user actually sees.
func captureServiceOutput(t *testing.T, fn func()) string {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	prevOut, prevErr := os.Stdout, os.Stderr
	os.Stdout, os.Stderr = w, w
	collected := make(chan string, 1)
	go func() {
		b, _ := io.ReadAll(r)
		collected <- string(b)
	}()

	fn()

	os.Stdout, os.Stderr = prevOut, prevErr
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	out := <-collected
	r.Close()
	return out
}
