package drivefs

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/hanwen/go-fuse/v2/fuse"
)

func TestErrorsLogSaysWhyAndKeepsTheLastLines(t *testing.T) {
	dir := t.TempDir()
	now := time.Date(2026, 11, 20, 10, 0, 0, 0, time.UTC)
	r := NewReporter(ReporterOptions{Dir: dir, MaxLines: 10, Now: func() time.Time { return now }})
	r.Log(fuse.Status(syscall.EOPNOTSUPP), "write", "/home/orbit/Drive/Proj/app.db", "at offset 4096",
		"the drive does not change a file in place; write a new file and rename it over the old one")
	data, _ := os.ReadFile(filepath.Join(dir, "errors.log"))
	want := "2026-11-20T10:00:00Z EOPNOTSUPP write /home/orbit/Drive/Proj/app.db at offset 4096: the drive does not change a file in place; write a new file and rename it over the old one\n"
	if string(data) != want {
		t.Fatalf("errors.log:\n%q\nwant\n%q", data, want)
	}
	// The same line within a second is not repeated.
	r.Log(fuse.Status(syscall.EOPNOTSUPP), "write", "/home/orbit/Drive/Proj/app.db", "at offset 4096", "again")
	if n := len(r.Lines()); n != 1 {
		t.Fatalf("lines %d", n)
	}
	for i := 0; i < 30; i++ {
		now = now.Add(2 * time.Second)
		r.Log(fuse.EPERM, "chmod", "/home/orbit/Drive/x", "", "line")
	}
	data, _ = os.ReadFile(filepath.Join(dir, "errors.log"))
	if lines := strings.Count(string(data), "\n"); lines > 12 || lines < 10 {
		t.Fatalf("errors.log keeps about the last 10 lines, holds %d", lines)
	}
	// A new daemon of the same mount keeps what the last one wrote.
	again := NewReporter(ReporterOptions{Dir: dir, MaxLines: 10})
	if n := len(again.Lines()); n != 10 {
		t.Fatalf("kept %d lines", n)
	}
}

func TestUnsentKeepsTheBytesUnderItsLimit(t *testing.T) {
	dir := t.TempDir()
	now := time.Date(2026, 11, 20, 10, 0, 0, 0, time.UTC)
	r := NewReporter(ReporterOptions{Dir: dir, ShownDir: "/run/orbit-drive", UnsentLimit: 25, Now: func() time.Time { return now }})
	first := r.SaveUnsent("a.txt", []byte("0123456789"), UnsentRecord{CommitID: "c1", EntryID: "e1"})
	now = now.Add(time.Second)
	second := r.SaveUnsent("b.txt", []byte("0123456789"), UnsentRecord{CommitID: "c2", EntryID: "e2"})
	if data, err := os.ReadFile(filepath.Join(dir, "unsent", first)); err != nil || string(data) != "0123456789" {
		t.Fatalf("first: %q %v", data, err)
	}
	if r.UnsentPath(first) != "/run/orbit-drive/unsent/"+first {
		t.Fatalf("shown as %s", r.UnsentPath(first))
	}
	now = now.Add(time.Second)
	r.SaveUnsent("c.txt", []byte("0123456789"), UnsentRecord{CommitID: "c3", EntryID: "e3"})
	// Over 25 bytes: the oldest went first, and errors.log says so.
	if _, err := os.Stat(filepath.Join(dir, "unsent", first)); !os.IsNotExist(err) {
		t.Fatal("the oldest is removed first")
	}
	if !strings.Contains(strings.Join(r.Lines(), "\n"), first+": removed (10 bytes) to keep unsent/ under 25 bytes") {
		t.Fatalf("lines %v", r.Lines())
	}
	// A commit that did apply after all: removed. One that did not: kept, until 24 h.
	r.CheckUnsent(context.Background(), func(ctx context.Context, id string) (bool, error) { return id == "c2", nil })
	if _, err := os.Stat(filepath.Join(dir, "unsent", second)); !os.IsNotExist(err) {
		t.Fatal("the unsent file whose commit applied is removed")
	}
	if r.CurrentStatus().UnsentFiles != 1 {
		t.Fatalf("status %+v", r.CurrentStatus())
	}
	now = now.Add(25 * time.Hour)
	r.CheckUnsent(context.Background(), func(context.Context, string) (bool, error) { return false, nil })
	if r.CurrentStatus().UnsentFiles != 0 {
		t.Fatal("removed after 24 h")
	}
}

func TestStatusSaysConnectedAndSinceWhenNot(t *testing.T) {
	dir := t.TempDir()
	r := NewReporter(ReporterOptions{Dir: dir})
	since := time.Date(2026, 11, 20, 10, 0, 0, 0, time.UTC)
	r.SetConnected(false, since)
	data, _ := os.ReadFile(filepath.Join(dir, "status.json"))
	if !strings.Contains(string(data), `"connected": false`) || !strings.Contains(string(data), `"since": "2026-11-20T10:00:00Z"`) {
		t.Fatalf("status.json %s", data)
	}
	r.SetConnected(true, since)
	data, _ = os.ReadFile(filepath.Join(dir, "status.json"))
	if !strings.Contains(string(data), `"connected": true`) || !strings.Contains(string(data), `"since": null`) {
		t.Fatalf("status.json %s", data)
	}
}

func TestNamesTheDriveCannotKeep(t *testing.T) {
	if checkName(strings.Repeat("n", 255)) != fuse.OK {
		t.Fatal("255 bytes is a name")
	}
	if checkName(strings.Repeat("n", 256)) != fuse.Status(syscall.ENAMETOOLONG) {
		t.Fatal("256 bytes is too long")
	}
	if checkName("bad\xff") != fuse.EINVAL {
		t.Fatal("not UTF-8")
	}
	if checkName("résumé (2).pdf") != fuse.OK {
		t.Fatal("UTF-8 is kept as it is")
	}
}
