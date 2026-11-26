package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The entrypoint makes ~/Drive the drive's link, at every start (§6.1, §5.9 row 61).
func TestEnsureDriveLink(t *testing.T) {
	dir := t.TempDir()
	oldMount, oldHome := driveMountPath, driveHomePath
	t.Cleanup(func() { driveMountPath, driveHomePath = oldMount, oldHome })
	driveMountPath = filepath.Join(dir, "run", "orbit-drive", "drive")
	driveHomePath = filepath.Join(dir, "home", "orbit", "Drive")
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
		t.Fatalf("a runner without /run/orbit-drive got %s", driveHomePath)
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

// A link an earlier runner made at ~/Documents or ~/Files to the mount is removed; a real directory there is kept.
func TestEnsureDriveLinkRemovesStaleLinks(t *testing.T) {
	dir := t.TempDir()
	oldMount, oldHome, oldStale := driveMountPath, driveHomePath, driveStaleHomePaths
	t.Cleanup(func() { driveMountPath, driveHomePath, driveStaleHomePaths = oldMount, oldHome, oldStale })
	driveMountPath = filepath.Join(dir, "run", "orbit-drive", "drive")
	driveHomePath = filepath.Join(dir, "home", "orbit", "Drive")
	docs := filepath.Join(dir, "home", "orbit", "Documents")
	files := filepath.Join(dir, "home", "orbit", "Files")
	driveStaleHomePaths = []string{docs, files}
	if err := os.MkdirAll(filepath.Dir(driveMountPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(docs), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(driveMountPath, files); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(docs, 0o755); err != nil {
		t.Fatal(err)
	}
	ensureDriveLink(func(string, ...interface{}) {})
	if target, err := os.Readlink(driveHomePath); err != nil || target != driveMountPath {
		t.Fatalf("~/Drive is not the link: %q %v", target, err)
	}
	if _, err := os.Lstat(files); !os.IsNotExist(err) {
		t.Fatalf("the leftover ~/Files link stayed: %v", err)
	}
	if info, err := os.Lstat(docs); err != nil || !info.IsDir() {
		t.Fatalf("a real ~/Documents directory was not kept: %v", err)
	}
	// A link to somewhere else is left alone.
	other := filepath.Join(dir, "elsewhere")
	if err := os.Remove(docs); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(other, docs); err != nil {
		t.Fatal(err)
	}
	ensureDriveLink(func(string, ...interface{}) {})
	if target, err := os.Readlink(docs); err != nil || target != other {
		t.Fatalf("a link elsewhere was touched: %q %v", target, err)
	}
}

// A runner of the Documents or Files era linked ~/Documents and ~/Files to its own driver's mount. In a Pod of the
// Drive driver those links point at /run/orbit-documents/drive and /run/orbit-files/drive, not at the mount, and are
// still the earlier runner's: they go too (seen on Orbit Cloud on 2026-11-25).
func TestEnsureDriveLinkRemovesLinksToOlderDriversMounts(t *testing.T) {
	dir := t.TempDir()
	oldMount, oldHome, oldStale, oldTargets := driveMountPath, driveHomePath, driveStaleHomePaths, driveStaleLinkTargets
	t.Cleanup(func() {
		driveMountPath, driveHomePath, driveStaleHomePaths, driveStaleLinkTargets = oldMount, oldHome, oldStale, oldTargets
	})
	driveMountPath = filepath.Join(dir, "run", "orbit-drive", "drive")
	driveHomePath = filepath.Join(dir, "home", "orbit", "Drive")
	docs := filepath.Join(dir, "home", "orbit", "Documents")
	files := filepath.Join(dir, "home", "orbit", "Files")
	driveStaleHomePaths = []string{docs, files}
	driveStaleLinkTargets = []string{"/run/orbit-documents/drive", "/run/orbit-files/drive"}
	if err := os.MkdirAll(filepath.Dir(driveMountPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(docs), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("/run/orbit-documents/drive", docs); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("/run/orbit-files/drive", files); err != nil {
		t.Fatal(err)
	}
	ensureDriveLink(func(string, ...interface{}) {})
	for _, stale := range []string{docs, files} {
		if _, err := os.Lstat(stale); !os.IsNotExist(err) {
			t.Fatalf("the leftover link %s stayed: %v", stale, err)
		}
	}
	if target, err := os.Readlink(driveHomePath); err != nil || target != driveMountPath {
		t.Fatalf("~/Drive is not the link: %q %v", target, err)
	}
}
