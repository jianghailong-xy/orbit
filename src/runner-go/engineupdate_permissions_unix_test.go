//go:build !windows

package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"
)

const engineUnwritableChildEnv = "ORBIT_TEST_ENGINE_UNWRITABLE_PATH"

func assertEngineBinaryNotUpdatable(t *testing.T, path string) {
	t.Helper()
	if os.Geteuid() == 0 {
		t.Fatal("unwritable engine probe unexpectedly retained uid 0")
	}
	if _, ok := engineBinaryUpdatable(path); ok {
		t.Fatal("a binary this user cannot write should not be attempted")
	}
}

func assertEngineBinaryNotUpdatableAsRunner(t *testing.T, path string) {
	t.Helper()
	if os.Geteuid() != 0 {
		assertEngineBinaryNotUpdatable(t, path)
		return
	}

	// Root is the production runner on appliance installs and can write regardless
	// of mode. Re-execute this exact test as uid 65534 so the kernel, not a mocked
	// permission predicate, proves the non-owner branch.
	dir := filepath.Dir(path)
	if err := os.Chmod(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(reachableTestBinary(t), "-test.run=^TestEngineBinaryUpdatable$")
	cmd.Env = append(os.Environ(), engineUnwritableChildEnv+"="+path)
	cmd.SysProcAttr = &syscall.SysProcAttr{
		Credential: &syscall.Credential{Uid: hostSetupChildUID, Gid: hostSetupChildGID},
	}
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("unprivileged engine permission probe failed: %v\n%s", err, out)
	}
}
