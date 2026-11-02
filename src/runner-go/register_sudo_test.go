package main

import (
	"errors"
	"os"
	"os/user"
	"slices"
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
		name, sudoUser string
		euid           int
		want           *user.User
	}{
		{"root under sudo from c2b", "c2b", 0, c2b},
		{"c2b itself, as sudo -u c2b leaves it", "root", 4242, nil},
		{"c2b, not under sudo", "", 4242, nil},
		{"root's own login", "", 0, nil},
		{"sudo run by root", "root", 0, nil},
		{"an account this machine does not have", "ghost", 0, nil},
		{"another name for root", "toor", 0, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("SUDO_USER", tc.sudoUser)
			processEUID = func() int { return tc.euid }
			got, ok := sudoAccount()
			if ok != (tc.want != nil) || got != tc.want {
				t.Fatalf("sudoAccount() = %v, %v; want %v", got, ok, tc.want)
			}
		})
	}
}

// sudo resets the environment it starts the account's command with; the hand-off carries over what
// register still reads, and nothing else.
func TestSudoHandOffCarriesWhatRegisterReads(t *testing.T) {
	for _, k := range sudoHandOffEnv {
		t.Setenv(k, "")
		os.Unsetenv(k)
	}
	t.Setenv("ORBIT_HOME", "/srv/orbit-c2b")
	t.Setenv("https_proxy", "http://proxy.internal:3128")
	t.Setenv("ORBIT_SESSION_ID", "not-carried")
	got := sudoHandOffArgv("/usr/bin/sudo", "c2b", "/usr/local/bin/orbit", []string{"register", "--name", "c2b-load-2"})
	want := []string{"/usr/bin/sudo", "-H", "-u", "c2b", "--", "env",
		"ORBIT_HOME=/srv/orbit-c2b", "https_proxy=http://proxy.internal:3128",
		"/usr/local/bin/orbit", "register", "--name", "c2b-load-2"}
	if !slices.Equal(got, want) {
		t.Fatalf("sudoHandOffArgv =\n  %q\nwant\n  %q", got, want)
	}
}
