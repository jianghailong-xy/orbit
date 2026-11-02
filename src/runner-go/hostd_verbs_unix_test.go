//go:build unix

package main

import (
	"os"
	"os/user"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

// The check behind enable's refusal, on a real machine: /bin/sh run as the account answers
// whether the account can execute its copy. As root the suite asks as uid 65534, and a file
// only root could execute is then a no — proof the answer is the account's and not root's;
// unprivileged, it asks as itself. A symlink is followed as the account follows it.
func TestAccountCanExecuteAsksAsTheAccount(t *testing.T) {
	account := &user.User{Uid: strconv.Itoa(os.Getuid()), Gid: strconv.Itoa(os.Getgid()), Username: "tester"}
	if os.Geteuid() == 0 {
		account = &user.User{Uid: strconv.Itoa(hostSetupChildUID), Gid: strconv.Itoa(hostSetupChildGID), Username: "nobody"}
	}
	uid, _ := strconv.Atoi(account.Uid)
	gid, _ := strconv.Atoi(account.Gid)

	dir := t.TempDir()
	// t.TempDir() and the directory it makes it in are 0700, and the account has to be able
	// to reach what it is asked about.
	for _, p := range []string{filepath.Dir(dir), dir} {
		if err := os.Chmod(p, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	file := func(name string, mode os.FileMode, owned bool) string {
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, []byte("#!/bin/sh\n"), mode); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(path, mode); err != nil {
			t.Fatal(err)
		}
		if owned && os.Geteuid() == 0 {
			if err := os.Chown(path, uid, gid); err != nil {
				t.Fatal(err)
			}
		}
		return path
	}
	link := func(name, target string) string {
		path := filepath.Join(dir, name)
		if err := os.Symlink(target, path); err != nil {
			t.Fatal(err)
		}
		return path
	}
	if err := os.Mkdir(filepath.Join(dir, "a-directory"), 0o755); err != nil {
		t.Fatal(err)
	}

	executable := file("orbit", 0o755, true)
	cases := []struct {
		name string
		path string
		want bool
	}{
		{"the account's executable copy", executable, true},
		{"a copy it cannot execute", file("orbit-0644", 0o644, true), false},
		{"no file at all", filepath.Join(dir, "missing"), false},
		{"a directory", filepath.Join(dir, "a-directory"), false},
		{"a symlink to its executable copy", link("via-link", executable), true},
		{"a symlink to nothing", link("dangling", filepath.Join(dir, "missing")), false},
	}
	if os.Geteuid() == 0 {
		// Root may execute it; the account may not.
		cases = append(cases, struct {
			name string
			path string
			want bool
		}{"a file only root may execute", file("roots-0700", 0o700, false), false})
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := accountCanExecute(account, c.path)
			if err != nil {
				t.Fatalf("accountCanExecute(%s): %v", c.path, err)
			}
			if got != c.want {
				t.Errorf("accountCanExecute(%s) = %v, want %v", c.path, got, c.want)
			}
		})
	}

	// No answer in time is never a yes.
	prev := hostdCopyCheckTimeout
	hostdCopyCheckTimeout = time.Nanosecond
	t.Cleanup(func() { hostdCopyCheckTimeout = prev })
	if got, err := accountCanExecute(account, executable); got || err == nil {
		t.Errorf("a check that ran out of time = %v, %v; want a refusal with its reason", got, err)
	}
}
