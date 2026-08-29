//go:build windows

package main

import (
	"os"
	"testing"
)

const engineUnwritableChildEnv = "ORBIT_TEST_ENGINE_UNWRITABLE_PATH"

func assertEngineBinaryNotUpdatable(t *testing.T, path string) {
	t.Helper()
	if _, ok := engineBinaryUpdatable(path); ok {
		t.Fatal("a read-only engine binary should not be attempted")
	}
}

func assertEngineBinaryNotUpdatableAsRunner(t *testing.T, path string) {
	t.Helper()
	if err := os.Chmod(path, 0o444); err != nil {
		t.Fatal(err)
	}
	assertEngineBinaryNotUpdatable(t, path)
}
