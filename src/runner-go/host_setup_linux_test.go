package main

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

const hostSetupChildEnv = "ORBIT_TEST_HOST_SETUP_CHILD"

// TestHostSetupChildRunsMain is the child half of the test below rather than a test of
// its own: re-executed with a non-root uid, it runs the real CLI so the real exit status
// can be observed.
func TestHostSetupChildRunsMain(t *testing.T) {
	if os.Getenv(hostSetupChildEnv) != "1" {
		// The assertion lives in TestHostSetupWithoutRootExitsOne, which re-executes
		// this entry point with a genuinely unprivileged uid. A normal suite pass has
		// no child payload to execute and is not an untested platform condition.
		return
	}
	os.Args = []string{"orbit", "host", "setup", "--server", "https://orbit.example.com"}
	main()
}

// The unit test next door proves a non-root setup fails with the line to re-run; this
// proves what a shell actually sees — the whole CLI, an euid that really is not root's,
// and the exit status a provisioning script branches on.
func TestHostSetupWithoutRootExitsOne(t *testing.T) {
	// The test proves a refused setup leaves no unit behind, which a host whose runner was really installed cannot
	// show: the unit is there before the test starts (it fails on such a host on plain origin/main too; job
	// bgj_b795bcd0e044 of task 34y6irXzFXq0nJqe51xR9).
	if _, err := os.Stat(hostRunnerTemplatePath); err == nil {
		t.Skipf("%s is installed on this host already, so a refused setup cannot be shown to leave it absent", hostRunnerTemplatePath)
	}
	binary := reachableTestBinary(t)
	cmd := exec.Command(binary, "-test.run=^TestHostSetupChildRunsMain$")
	cmd.Env = append(os.Environ(), hostSetupChildEnv+"=1")
	if os.Geteuid() == 0 {
		// Drop the child, since a root child would install the units for real. When the
		// suite is already unprivileged the child inherits that and needs no help.
		cmd.SysProcAttr = &syscall.SysProcAttr{
			Credential: &syscall.Credential{Uid: hostSetupChildUID, Gid: hostSetupChildGID},
		}
	}
	// The host may legitimately have the runner installed already, so what is checked is
	// what the refused setup did to these paths, not what the machine had beforehand.
	unitPaths := []string{hostRunnerTemplatePath, hostdSocketUnitPath, hostdServiceUnitPath}
	before := snapshotUnitFiles(t, unitPaths)
	out, err := cmd.CombinedOutput()

	var exit *exec.ExitError
	if !errors.As(err, &exit) {
		t.Fatalf("a non-root `orbit host setup` must exit non-zero, got %v:\n%s", err, out)
	}
	if exit.ExitCode() != 1 {
		t.Errorf("exit code %d, want 1:\n%s", exit.ExitCode(), out)
	}
	// Run from a copy other than /usr/local/bin/orbit, the refusal names the root-owned copy to
	// put in place and the setup to run from it, since re-running this copy under sudo would only
	// be refused next.
	self, err := filepath.EvalSymlinks(binary)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"sudo install -o 0 -g 0 -m 0755 " + self + " " + machineBinaryPath + "\n",
		"sudo " + machineBinaryPath + " host setup --server https://orbit.example.com\n",
	} {
		if !strings.Contains(string(out), want) {
			t.Errorf("the CLI must print %q, got:\n%s", want, out)
		}
	}
	// Refusing early is the whole point: the machine must be exactly as it was.
	for _, change := range unitFileChanges(before, snapshotUnitFiles(t, unitPaths)) {
		t.Errorf("a refused setup changed the host: %s", change)
	}
}

// unitFileState is what a path looked like at one moment: absent, or its size, mtime and
// content hash.
type unitFileState struct {
	exists  bool
	size    int64
	modTime int64
	sum     [sha256.Size]byte
}

func snapshotUnitFiles(t *testing.T, paths []string) map[string]unitFileState {
	t.Helper()
	states := make(map[string]unitFileState, len(paths))
	for _, path := range paths {
		info, err := os.Stat(path)
		if os.IsNotExist(err) {
			states[path] = unitFileState{}
			continue
		}
		if err != nil {
			t.Fatal(err)
		}
		b, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		states[path] = unitFileState{exists: true, size: info.Size(), modTime: info.ModTime().UnixNano(), sum: sha256.Sum256(b)}
	}
	return states
}

// unitFileChanges names every path whose state differs between the two snapshots: one
// absent before must still be absent, one present before must be byte-identical with the
// same mtime.
func unitFileChanges(before, after map[string]unitFileState) []string {
	var changes []string
	for path, was := range before {
		now := after[path]
		switch {
		case !was.exists && now.exists:
			changes = append(changes, fmt.Sprintf("%s was created", path))
		case was.exists && !now.exists:
			changes = append(changes, fmt.Sprintf("%s was removed", path))
		case was != now:
			changes = append(changes, fmt.Sprintf("%s was modified", path))
		}
	}
	return changes
}

// The before/after comparison above is the only thing standing between a setup that writes
// a unit and a green test, so prove it notices each way a unit file can change.
func TestHostSetupUnitSnapshotSeesChanges(t *testing.T) {
	dir := t.TempDir()
	absent := filepath.Join(dir, "absent.service")
	present := filepath.Join(dir, "present.service")
	if err := os.WriteFile(present, []byte("[Unit]\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	paths := []string{absent, present}
	before := snapshotUnitFiles(t, paths)
	if changes := unitFileChanges(before, snapshotUnitFiles(t, paths)); len(changes) != 0 {
		t.Fatalf("an untouched host reported changes: %v", changes)
	}

	if err := os.WriteFile(absent, []byte("[Unit]\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if changes := unitFileChanges(before, snapshotUnitFiles(t, paths)); len(changes) != 1 || !strings.Contains(changes[0], "absent.service was created") {
		t.Errorf("a created unit must be reported, got %v", changes)
	}
	if err := os.Remove(absent); err != nil {
		t.Fatal(err)
	}

	// Same size, different bytes, mtime restored: only the hash can see it.
	info, err := os.Stat(present)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(present, []byte("[Unix]\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(present, info.ModTime(), info.ModTime()); err != nil {
		t.Fatal(err)
	}
	if changes := unitFileChanges(before, snapshotUnitFiles(t, paths)); len(changes) != 1 || !strings.Contains(changes[0], "present.service was modified") {
		t.Errorf("a rewritten unit must be reported, got %v", changes)
	}

	// Same bytes, new mtime: rewritten in place still counts.
	if err := os.WriteFile(present, []byte("[Unit]\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(present, info.ModTime().Add(time.Second), info.ModTime().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	if changes := unitFileChanges(before, snapshotUnitFiles(t, paths)); len(changes) != 1 || !strings.Contains(changes[0], "present.service was modified") {
		t.Errorf("a re-touched unit must be reported, got %v", changes)
	}
}
