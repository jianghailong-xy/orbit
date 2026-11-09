package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestCursorSandboxMacOSLaunchFiles(t *testing.T) {
	work := t.TempDir()
	t.Setenv("ORBIT_HOME", t.TempDir())
	if err := os.MkdirAll(runnerCacheRoot(), 0700); err != nil {
		t.Fatal(err)
	}
	sandbox, reason := detectCursorSandbox(context.Background(), nil, work)
	if sandbox == nil {
		t.Fatal(reason)
	}
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	ancestor := filepath.Join(base, "launcher")
	sealed := filepath.Join(ancestor, "bin")
	if err := os.MkdirAll(sealed, 0700); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(sealed, "sandbox.json")
	if err := os.WriteFile(file, []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	sandbox.sealed = []string{sealed}
	for _, command := range []string{
		"printf replaced > " + shellQuote(file),
		"mv " + shellQuote(ancestor) + " " + shellQuote(ancestor+"-moved"),
	} {
		cmd := exec.Command("/bin/bash", "-c", command)
		sandbox.wrap(cmd)
		if out, err := cmd.CombinedOutput(); err == nil {
			t.Fatalf("launch-file mutation succeeded: %s: %s", command, out)
		}
	}
	if data, err := os.ReadFile(file); err != nil || string(data) != "original" {
		t.Fatalf("sealed file changed: %q, %v", data, err)
	}
}
