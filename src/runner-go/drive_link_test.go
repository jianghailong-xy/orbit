package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The entrypoint makes ~/Documents the drive's link, at every start (§6.1, §5.9 row 61).
func TestEnsureDriveLink(t *testing.T) {
	dir := t.TempDir()
	oldMount, oldHome := driveMountPath, driveHomePath
	t.Cleanup(func() { driveMountPath, driveHomePath = oldMount, oldHome })
	driveMountPath = filepath.Join(dir, "run", "orbit-documents", "drive")
	driveHomePath = filepath.Join(dir, "home", "orbit", "Files")
	var logged []string
	logf := func(format string, args ...interface{}) { logged = append(logged, fmt.Sprintf(format, args...)) }
	link := func() string {
		target, err := os.Readlink(driveHomePath)
		if err != nil {
			return ""
		}
		return target
	}

	// A runner that does not receive the drive is not touched.
	ensureDriveLink(logf)
	if _, err := os.Lstat(driveHomePath); !os.IsNotExist(err) {
		t.Fatalf("a runner without /run/orbit-documents got %s", driveHomePath)
	}

	if err := os.MkdirAll(filepath.Dir(driveMountPath), 0o755); err != nil {
		t.Fatal(err)
	}
	ensureDriveLink(logf)
	if link() != driveMountPath {
		t.Fatalf("the link is %q", link())
	}

	// Removed by an agent, it is back at the next start.
	if err := os.Remove(driveHomePath); err != nil {
		t.Fatal(err)
	}
	ensureDriveLink(logf)
	if link() != driveMountPath {
		t.Fatalf("the link was not made again: %q", link())
	}
	if len(logged) != 0 {
		t.Fatalf("nothing was moved, yet: %v", logged)
	}

	// A folder of the agent's own at that name is kept aside, not lost.
	if err := os.Remove(driveHomePath); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(driveHomePath, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(driveHomePath, "mine.txt"), []byte("mine"), 0o644); err != nil {
		t.Fatal(err)
	}
	ensureDriveLink(logf)
	if link() != driveMountPath {
		t.Fatalf("the link was not made over a folder: %q", link())
	}
	kept, _ := filepath.Glob(driveHomePath + ".local-*")
	if len(kept) != 1 {
		t.Fatalf("kept: %v", kept)
	}
	if data, err := os.ReadFile(filepath.Join(kept[0], "mine.txt")); err != nil || string(data) != "mine" {
		t.Fatalf("the folder's file: %q %v", data, err)
	}
	if len(logged) != 1 || !strings.Contains(logged[0], kept[0]) {
		t.Fatalf("the move is logged: %v", logged)
	}

	// A link to anywhere else is moved aside too.
	if err := os.Remove(driveHomePath); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(dir, driveHomePath); err != nil {
		t.Fatal(err)
	}
	ensureDriveLink(logf)
	if link() != driveMountPath {
		t.Fatalf("a wrong link stayed: %q", link())
	}
	if kept, _ := filepath.Glob(driveHomePath + ".local-*"); len(kept) != 2 {
		t.Fatalf("each thing moved aside is kept under its own name: %v", kept)
	}
}
