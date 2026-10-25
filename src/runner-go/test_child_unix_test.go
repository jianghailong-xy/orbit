//go:build !windows

package main

// What the tests that re-execute this test binary as an unprivileged child share, on every platform but
// Windows: `orbit host setup` (host_setup_linux_test.go), the project CLI exit codes, and an engine binary
// the runner may not update (engineupdate_permissions_unix_test.go), which macOS builds too.

import (
	"os"
	"path/filepath"
	"testing"
)

// An unprivileged uid to run the child as when the suite itself is root. Nothing is
// looked up: the point is only that it is not 0.
const (
	hostSetupChildUID = 65534
	hostSetupChildGID = 65534
)

// reachableTestBinary copies this test binary somewhere the unprivileged child can
// actually execute it: `go test` builds it under a 0700 directory, which the child
// cannot traverse.
func reachableTestBinary(t *testing.T) string {
	t.Helper()
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	binary, err := os.ReadFile(self)
	if err != nil {
		t.Fatal(err)
	}
	dir, err := os.MkdirTemp("", "orbit-host-setup")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	if err := os.Chmod(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "orbit.test")
	if err := os.WriteFile(path, binary, 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}
