package main

import (
	"os"
	"path/filepath"
	"testing"
)

// The real syncfs, on what exists: a missing path is skipped, not an error.
func TestSyncFilesystemsOfSyncsWhatExists(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "written")
	if err := os.WriteFile(file, []byte("not yet on the disk\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := syncFilesystemsOf([]string{dir, file, filepath.Join(dir, "missing"), ""}); err != nil {
		t.Fatalf("syncfs: %v", err)
	}
}
