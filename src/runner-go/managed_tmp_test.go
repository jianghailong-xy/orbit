//go:build linux

package main

import (
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// tmpFixture is a temporary directory as a session leaves it: files, a nested tree, a link out of it, the
// daemon's own entries and a socket, all written an hour ago, plus a file written just now.
func tmpFixture(t *testing.T) (dir, outside string) {
	t.Helper()
	dir = t.TempDir()
	outside = filepath.Join(t.TempDir(), "outside")
	must(t, os.WriteFile(outside, []byte("not the temporary directory's"), 0o600))
	must(t, os.MkdirAll(filepath.Join(dir, "go-build123", "b001", "exe"), 0o700))
	must(t, os.WriteFile(filepath.Join(dir, "go-build123", "b001", "exe", "a.out"), []byte("binary"), 0o700))
	must(t, os.WriteFile(filepath.Join(dir, "scratch.txt"), []byte("left"), 0o600))
	must(t, os.Symlink(outside, filepath.Join(dir, "link-out")))
	must(t, os.MkdirAll(filepath.Join(dir, ".X11-unix"), 0o700))
	must(t, os.WriteFile(filepath.Join(dir, "orbit-browser.pgids"), []byte("12"), 0o600))
	listener, err := net.Listen("unix", filepath.Join(dir, "live.sock"))
	must(t, err)
	t.Cleanup(func() { listener.Close() })
	hourAgo := time.Now().Add(-time.Hour)
	for _, name := range []string{"go-build123/b001/exe/a.out", "go-build123/b001/exe", "go-build123/b001", "go-build123",
		"scratch.txt", ".X11-unix", "orbit-browser.pgids"} {
		must(t, os.Chtimes(filepath.Join(dir, name), hourAgo, hourAgo))
	}
	must(t, os.WriteFile(filepath.Join(dir, "being-written"), []byte("now"), 0o600))
	return dir, outside
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func tmpNames(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	must(t, err)
	var names []string
	for _, e := range entries {
		names = append(names, e.Name())
	}
	return names
}

// At daemon start everything in the temporary directory goes — the processes that wrote it ended with the
// container before — and a link is removed as a link, never followed.
func TestSweepTmpAtStartEmptiesTheDirectory(t *testing.T) {
	dir, outside := tmpFixture(t)
	sweepTmpAtStart(newSessionPool(2), dir)
	if names := tmpNames(t, dir); len(names) != 0 {
		t.Fatalf("left in the temporary directory after the start sweep: %v", names)
	}
	if data, err := os.ReadFile(outside); err != nil || string(data) != "not the temporary directory's" {
		t.Fatalf("the link's target was touched: %q, %v", data, err)
	}
}

// A job the process before handed on is still running, and its files may be in there: the start sweep waits
// for another day.
func TestSweepTmpAtStartKeepsWhatAnAdoptedJobMayUse(t *testing.T) {
	dir, _ := tmpFixture(t)
	pool := newSessionPool(2)
	pool.holdWorktreeForRunnerJob("adopted", "bgj_A", "bgj_A")
	before := tmpNames(t, dir)
	sweepTmpAtStart(pool, dir)
	if after := tmpNames(t, dir); strings.Join(after, ",") != strings.Join(before, ",") {
		t.Fatalf("the start sweep ran beside a running job: %v -> %v", before, after)
	}
}

// When a session ends and nothing else runs, what the work left goes; the daemon's own entries, a live
// socket and what was written within the quiet period stay (the link among them: it was made just now).
func TestSweepTmpWhenIdleAtSessionEnd(t *testing.T) {
	dir, outside := tmpFixture(t)
	sweepTmpWhenIdle(newSessionPool(2), dir, time.Now())
	got := strings.Join(tmpNames(t, dir), ",")
	if want := ".X11-unix,being-written,link-out,live.sock,orbit-browser.pgids"; got != want {
		t.Fatalf("after the session-end sweep the temporary directory holds %s, want %s", got, want)
	}
	if _, err := os.Stat(outside); err != nil {
		t.Fatalf("the link's target is gone: %v", err)
	}
}

// A tree in which anything was written within the quiet period is somebody's still: it stays whole.
func TestSweepTmpWhenIdleKeepsATreeWrittenRecently(t *testing.T) {
	dir := t.TempDir()
	deep := filepath.Join(dir, "claude-10001", "project", "tasks")
	must(t, os.MkdirAll(deep, 0o700))
	must(t, os.WriteFile(filepath.Join(deep, "out.txt"), []byte("now"), 0o600))
	hourAgo := time.Now().Add(-time.Hour)
	must(t, os.Chtimes(filepath.Join(dir, "claude-10001"), hourAgo, hourAgo))
	sweepTmpWhenIdle(newSessionPool(2), dir, time.Now())
	if _, err := os.Stat(filepath.Join(deep, "out.txt")); err != nil {
		t.Fatalf("a tree written a moment ago was swept: %v", err)
	}
}

// While another session holds a turn, or a background job runs, a session's end sweeps nothing.
func TestSweepTmpWhenIdleWaitsWhileAnythingRuns(t *testing.T) {
	for name, occupy := range map[string]func(*sessionPool){
		"a session holding a turn": func(p *sessionPool) {
			if _, added := p.register(&ClaimedSession{SessionID: "busy"}, func() {}, true); !added {
				t.Fatal("not registered")
			}
		},
		"a background job": func(p *sessionPool) { p.holdWorktreeForRunnerJob("parked", "bgj_B", "bgj_B") },
	} {
		t.Run(name, func(t *testing.T) {
			dir, _ := tmpFixture(t)
			pool := newSessionPool(2)
			occupy(pool)
			before := tmpNames(t, dir)
			sweepTmpWhenIdle(pool, dir, time.Now())
			if after := tmpNames(t, dir); strings.Join(after, ",") != strings.Join(before, ",") {
				t.Fatalf("swept while %s: %v -> %v", name, before, after)
			}
		})
	}
}

// Only home/.orbit-tmp itself, a real directory, is a managed runner's /tmp to sweep: not home, not another
// directory, and not whatever a link put in its place points at.
func TestIsVolumeTmpDir(t *testing.T) {
	home := t.TempDir()
	tmp := filepath.Join(home, managedTmpSubdir)
	if isVolumeTmpDir(tmp, home) {
		t.Error("a temporary directory that is not there reads as the volume's")
	}
	must(t, os.Mkdir(tmp, 0o1777))
	if !isVolumeTmpDir(tmp, home) {
		t.Error("home/.orbit-tmp does not read as the volume's temporary directory")
	}
	if isVolumeTmpDir(home, home) || isVolumeTmpDir(t.TempDir(), home) {
		t.Error("another directory reads as the volume's temporary directory")
	}
	state := filepath.Join(home, ".orbit")
	must(t, os.Mkdir(state, 0o700))
	must(t, os.Remove(tmp))
	must(t, os.Symlink(".orbit", tmp))
	if isVolumeTmpDir(state, home) {
		t.Error("the runner's state, behind a link in the temporary directory's place, reads as sweepable")
	}
}

// The wiring in runLoop: the start sweep runs once the jobs the process before handed on are adopted and
// before anything is reclaimed, and every supervisor's end asks for the session-end sweep after it has left
// the pool.
func TestRunLoopSweepsTmpAtStartAndAtSessionEnd(t *testing.T) {
	body := runLoopSource(t)
	adopt := strings.Index(body, "pool.adoptRecordedJobs()")
	start := strings.Index(body, "sweepManagedTmpAtStart(pool)")
	reclaim := strings.Index(body, "reclaimWaitedOnSessions(")
	if adopt < 0 || start < adopt || reclaim < start {
		t.Fatal("the start sweep does not run between adopting handed-on jobs and the reclaim")
	}
	finish := strings.Index(body, "pool.finish(live)")
	end := strings.Index(body, "sweepManagedTmpWhenIdle(pool)")
	if finish < 0 || end < finish || end-finish > 200 {
		t.Fatal("a supervisor's end does not ask for the session-end sweep once it has left the pool")
	}
}

func runLoopSource(t *testing.T) string {
	t.Helper()
	data, err := os.ReadFile("runloop.go")
	must(t, err)
	body := string(data)
	return body[strings.Index(body, "func runLoop("):]
}
