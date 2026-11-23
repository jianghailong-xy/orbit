//go:build linux && !race

package sandbox

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"testing"

	"golang.org/x/sys/unix"
)

// The filter is applied in a child process of the test binary: once applied it cannot be taken off.
// This test uses a pure Go binary because syscall.AllThreadsSyscall returns ENOTSUP with the cgo-linked race detector.
func TestLockdownRefusesWhatAFUSEServerNeverCalls(t *testing.T) {
	if os.Getenv("ORBIT_SANDBOX_CHILD") == "1" {
		child()
		return
	}
	cmd := exec.Command(os.Args[0], "-test.run=^TestLockdownRefusesWhatAFUSEServerNeverCalls$", "-test.v")
	cmd.Env = append(os.Environ(), "ORBIT_SANDBOX_CHILD=1")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("%v:\n%s", err, out)
	}
}

func child() {
	fail := func(format string, args ...interface{}) {
		fmt.Printf(format+"\n", args...)
		os.Exit(1)
	}
	dir, err := os.MkdirTemp("", "sandbox-")
	if err != nil {
		fail("%v", err)
	}
	defer os.RemoveAll(dir)
	if err := Lockdown(); err != nil {
		fail("lockdown: %v", err)
	}
	if err := unix.Unshare(unix.CLONE_NEWUSER); !errors.Is(err, unix.EPERM) {
		fail("unshare answered %v", err)
	}
	if err := unix.Mount("none", dir, "tmpfs", 0, ""); !errors.Is(err, unix.EPERM) {
		if err == nil {
			_ = unix.Unmount(dir, unix.MNT_DETACH)
		}
		fail("mount answered %v", err)
	}
	if err := unix.PtraceAttach(os.Getppid()); !errors.Is(err, unix.EPERM) {
		fail("ptrace answered %v", err)
	}
	if n, _ := unix.PrctlRetInt(unix.PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0); n != 1 {
		fail("no_new_privs %d", n)
	}
	if n, _ := unix.PrctlRetInt(unix.PR_GET_DUMPABLE, 0, 0, 0, 0); n != 0 {
		fail("dumpable %d", n)
	}
	// What a FUSE server does still works.
	if err := os.WriteFile(dir+"/f", []byte("x"), 0o600); err != nil {
		fail("write: %v", err)
	}
	if _, err := exec.Command("true").Output(); err != nil {
		fail("exec: %v", err)
	}
	os.Exit(0)
}
