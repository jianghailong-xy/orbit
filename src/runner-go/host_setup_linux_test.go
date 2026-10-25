package main

import (
	"errors"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"testing"
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
	cmd := exec.Command(reachableTestBinary(t), "-test.run=^TestHostSetupChildRunsMain$")
	cmd.Env = append(os.Environ(), hostSetupChildEnv+"=1")
	if os.Geteuid() == 0 {
		// Drop the child, since a root child would install the units for real. When the
		// suite is already unprivileged the child inherits that and needs no help.
		cmd.SysProcAttr = &syscall.SysProcAttr{
			Credential: &syscall.Credential{Uid: hostSetupChildUID, Gid: hostSetupChildGID},
		}
	}
	out, err := cmd.CombinedOutput()

	var exit *exec.ExitError
	if !errors.As(err, &exit) {
		t.Fatalf("a non-root `orbit host setup` must exit non-zero, got %v:\n%s", err, out)
	}
	if exit.ExitCode() != 1 {
		t.Errorf("exit code %d, want 1:\n%s", exit.ExitCode(), out)
	}
	if !strings.Contains(string(out), "sudo orbit host setup") {
		t.Errorf("the CLI must print the command to re-run, got:\n%s", out)
	}
	// Refusing early is the whole point: the machine must be exactly as it was.
	if _, err := os.Stat(hostRunnerTemplatePath); !os.IsNotExist(err) {
		t.Errorf("a refused setup left %s behind (%v)", hostRunnerTemplatePath, err)
	}
}
