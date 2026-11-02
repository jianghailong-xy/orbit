package main

import (
	"errors"
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
	prevEUID, prevLookup := processEUID, lookupUser
	t.Cleanup(func() { processEUID, lookupUser = prevEUID, prevLookup })
	lookupUser = func(name string) (*user.User, error) {
		switch name {
		case "c2b":
			return c2b, nil
		case "toor":
			return toor, nil
		}
		return nil, errors.New("no such account")
	}
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
		{"an account only sudo can look up", "ldap-user", "ldap-user", 0},
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

// sudo resets the environment it starts the account's command with; the hand-off keeps what register still
// reads, and nothing else. By name: a proxy's URL can hold a password, and sudo logs its command line.
func TestSudoHandOffCarriesWhatRegisterReads(t *testing.T) {
	for _, k := range sudoHandOffEnv {
		t.Setenv(k, "")
		os.Unsetenv(k)
	}
	args := []string{"register", "--name", "c2b-load-2"}
	got := sudoHandOffArgv("/usr/bin/sudo", "c2b", "/usr/local/bin/orbit", args)
	want := []string{"/usr/bin/sudo", "-H", "-u", "c2b", "--", "/usr/local/bin/orbit", "register", "--name", "c2b-load-2"}
	if !slices.Equal(got, want) {
		t.Fatalf("with nothing to keep, sudoHandOffArgv =\n  %q\nwant\n  %q", got, want)
	}

	t.Setenv("ORBIT_HOME", "/srv/orbit-c2b")
	t.Setenv("https_proxy", "http://user:secret@proxy.internal:3128")
	t.Setenv("SSL_CERT_FILE", "/etc/orbit/ca.pem")
	t.Setenv("ORBIT_SESSION_ID", "not-carried")
	got = sudoHandOffArgv("/usr/bin/sudo", "c2b", "/usr/local/bin/orbit", args)
	want = []string{"/usr/bin/sudo", "-H", "-u", "c2b", "--preserve-env=ORBIT_HOME,https_proxy,SSL_CERT_FILE", "--",
		"/usr/local/bin/orbit", "register", "--name", "c2b-load-2"}
	if !slices.Equal(got, want) {
		t.Fatalf("sudoHandOffArgv =\n  %q\nwant\n  %q", got, want)
	}
	if strings.Contains(strings.Join(got, " "), "secret") {
		t.Fatalf("the proxy's password is on sudo's command line: %q", got)
	}
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

	sudoSearchDirs = []string{filepath.Join(system, "absent")}
	if _, err := systemSudo(); err == nil || !strings.Contains(err.Error(), "no sudo in "+sudoSearchDirs[0]) {
		t.Fatalf("systemSudo() with none there = %v", err)
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
