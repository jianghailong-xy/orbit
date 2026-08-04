package main

import (
	"os"
	"testing"
)

// withStdin points os.Stdin at f for the duration of one test.
func withStdin(t *testing.T, f *os.File) {
	t.Helper()
	orig := os.Stdin
	os.Stdin = f
	t.Cleanup(func() { os.Stdin = orig })
}

// systemd, launchd, cron and agent harnesses all run a command with stdin on
// /dev/null — a character device, which is the property that used to stand in for
// "a person is here". Treating it as interactive makes prompts answer themselves.
func TestInteractiveRejectsDevNullStdin(t *testing.T) {
	f, err := os.Open(os.DevNull)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	withStdin(t, f)

	if interactive() {
		t.Fatal("stdin on /dev/null must not count as interactive")
	}
}

func TestInteractiveRejectsPipedStdin(t *testing.T) {
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	defer w.Close()
	withStdin(t, r)

	if interactive() {
		t.Fatal("piped stdin must not count as interactive")
	}
}

// The negative cases above are all satisfied by an interactive() that never says
// yes, so pin the other end too: a pty master is a terminal, and must still pass.
func TestInteractiveAcceptsTerminalStdin(t *testing.T) {
	f, err := os.OpenFile("/dev/ptmx", os.O_RDWR, 0)
	if err != nil {
		t.Skip("no pty available:", err)
	}
	defer f.Close()
	withStdin(t, f)

	if !interactive() {
		t.Fatal("a terminal on stdin must count as interactive")
	}
}
