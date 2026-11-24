//go:build linux || darwin

package main

import (
	"context"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// The sign-in's terminal is agy's own on Linux and macOS alike: a controlling TTY it leads, 4096
// columns wide so the authorization link never wraps, with what it prints copied out.
func TestAntigravityGooglePTYStartsATerminal(t *testing.T) {
	cmd := exec.CommandContext(context.Background(), "/bin/sh", "-c", `test -t 0 && test -t 1 && stty size && echo "pgid=$(ps -o pgid= -p $$ | tr -d ' ') pid=$$"; IFS= read -r line; echo "got=$line"`)
	out := &syncBuffer{}
	stdin, copied, err := startAntigravityGooglePTY(cmd, out)
	if err != nil {
		t.Fatal(err)
	}
	defer stdin.Close()
	if _, err := stdin.Write([]byte("typed\r")); err != nil {
		t.Fatal(err)
	}
	if err := cmd.Wait(); err != nil {
		t.Fatalf("shell under the PTY failed: %v\n%s", err, out.String())
	}
	select {
	case <-copied:
	case <-time.After(5 * time.Second):
	}
	text := out.String()
	pid := cmd.Process.Pid
	for _, want := range []string{"48 4096", "got=typed", "pgid=" + strconv.Itoa(pid) + " pid=" + strconv.Itoa(pid)} {
		if !strings.Contains(text, want) {
			t.Fatalf("PTY output lacks %q: %q", want, text)
		}
	}
}

// Cancelling a sign-in kills agy's whole process group, and only that.
func TestAntigravityGooglePTYCancelKillsItsGroup(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cmd := exec.CommandContext(ctx, "/bin/sh", "-c", `sleep 60 & echo "child=$!"; wait`)
	out := &syncBuffer{}
	stdin, _, err := startAntigravityGooglePTY(cmd, out)
	if err != nil {
		t.Fatal(err)
	}
	defer stdin.Close()
	child := 0
	for deadline := time.Now().Add(10 * time.Second); child == 0 && time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
		if _, rest, ok := strings.Cut(out.String(), "child="); ok {
			child, _ = strconv.Atoi(strings.TrimSpace(strings.SplitN(rest, "\n", 2)[0]))
		}
	}
	if child == 0 {
		t.Fatalf("the shell never named its child: %q", out.String())
	}
	cancel()
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("cancel left the sign-in's process running")
	}
	for deadline := time.Now().Add(5 * time.Second); syscall.Kill(child, 0) == nil; time.Sleep(20 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatalf("cancel left agy's child %d running", child)
		}
	}
}

// Where agy would reach a keychain (macOS), every Google-mode agy — the sign-in, its probes and model
// list, the approval check and the session — is kept to its Gemini directory's token file by
// SSH_CONNECTION. Where it would not (Linux), nothing changes.
func TestAntigravityGoogleKeepsToTheTokenFileWhereAKeychainIsReachable(t *testing.T) {
	if want := runtime.GOOS == "darwin"; antigravityKeychainPlatform != want {
		t.Fatalf("antigravityKeychainPlatform = %v on %s", antigravityKeychainPlatform, runtime.GOOS)
	}
	t.Setenv("ORBIT_HOME", t.TempDir())
	previous := antigravityKeychainPlatform
	t.Cleanup(func() { antigravityKeychainPlatform = previous })
	env := []string{"HOME=/home/someone", "PATH=/usr/bin:/bin", "SSH_CONNECTION=10.0.0.1 22 10.0.0.2 22"}
	noSSH := []string{"HOME=/home/someone", "PATH=/usr/bin:/bin"}
	for _, keychain := range []bool{false, true} {
		antigravityKeychainPlatform = keychain
		want := ""
		if keychain {
			want = antigravitySSHConnection
		}
		cmd, cleanup, err := antigravityGoogleCommand(context.Background(), "/fake/agy", env, false, "models")
		if err != nil {
			t.Fatal(err)
		}
		cleanup()
		if got := envValue(cmd.Env, "SSH_CONNECTION"); got != want {
			t.Fatalf("keychain=%v: Google command SSH_CONNECTION = %q, want %q", keychain, got, want)
		}
		if got := envValue(antigravityGoogleEnv(noSSH, "/tmp/gd"), "SSH_CONNECTION"); got != want {
			t.Fatalf("keychain=%v: session SSH_CONNECTION = %q, want %q", keychain, got, want)
		}
		if got := envValue(antigravityGoogleEnv(noSSH, "/tmp/gd"), "DBUS_SESSION_BUS_ADDRESS"); got != "unix:path=/tmp/gd/absent-dbus" {
			t.Fatalf("keychain=%v: session D-Bus = %q", keychain, got)
		}
	}
	// A runner's own SSH_CONNECTION reaches a Linux session as it always has.
	antigravityKeychainPlatform = false
	if got := envValue(antigravityGoogleEnv(env, "/tmp/gd"), "SSH_CONNECTION"); got != "10.0.0.1 22 10.0.0.2 22" {
		t.Fatalf("Linux session SSH_CONNECTION = %q", got)
	}
}

func TestAntigravityGoogleLoginDeclaresMacOS(t *testing.T) {
	if !contains(strings.Split(runnerCapabilitiesV1, ","), antigravityGoogleLoginMacOSCapabilityV1) {
		t.Fatalf("runner does not declare %s: %s", antigravityGoogleLoginMacOSCapabilityV1, runnerCapabilitiesV1)
	}
}
