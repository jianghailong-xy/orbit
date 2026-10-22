package main

import (
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// volumeSyncRecorder stands in for syncfs: it keeps the paths of every sync and, beside the
// requests a test notes, the order things happened in.
type volumeSyncRecorder struct {
	mu    sync.Mutex
	syncs [][]string
	order []string
}

func recordVolumeSyncs(t *testing.T) *volumeSyncRecorder {
	t.Helper()
	volumeSharedAs(t, false)
	r := &volumeSyncRecorder{}
	saved := syncFilesystems
	syncFilesystems = func(paths []string) error {
		r.mu.Lock()
		defer r.mu.Unlock()
		r.syncs = append(r.syncs, append([]string(nil), paths...))
		r.order = append(r.order, "sync")
		return nil
	}
	t.Cleanup(func() { syncFilesystems = saved })
	return r
}

// volumeSharedAs says whether the volume shares its filesystem (a Docker local volume) for one test,
// whatever filesystem the test's directories are on; recordVolumeSyncs starts with a volume of its own.
func volumeSharedAs(t *testing.T, shared bool) {
	t.Helper()
	saved := managedVolumeShared
	managedVolumeShared = func() bool { return shared }
	t.Cleanup(func() { managedVolumeShared = saved })
}

func (r *volumeSyncRecorder) note(step string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.order = append(r.order, step)
}

func (r *volumeSyncRecorder) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.syncs)
}

func (r *volumeSyncRecorder) steps() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.order...)
}

// A self-managed runner's filesystem is its owner's: nothing is synced, before a report or behind
// a tool.
func TestSelfManagedRunnerSyncsNothing(t *testing.T) {
	withoutManagedInstance(t)
	syncs := recordVolumeSyncs(t)

	syncManagedVolume("a turn", t.TempDir())
	background := &backgroundVolumeSync{}
	background.nudge()
	time.Sleep(20 * time.Millisecond)

	if syncs.count() != 0 {
		t.Fatalf("a self-managed runner synced its filesystem %d times", syncs.count())
	}
}

// A managed runner syncs the filesystem of its ORBIT_HOME and of each path it names.
func TestManagedRunnerSyncsItsVolume(t *testing.T) {
	withManagedInstance(t, "4", testManagedPodUID)
	home := t.TempDir()
	t.Setenv("ORBIT_HOME", home)
	syncs := recordVolumeSyncs(t)

	worktree := filepath.Join(t.TempDir(), "wt")
	syncManagedVolume("a turn", worktree)

	if syncs.count() != 1 {
		t.Fatalf("synced %d times, want once", syncs.count())
	}
	if got := syncs.syncs[0]; len(got) != 2 || got[0] != home || got[1] != worktree {
		t.Fatalf("synced %v, want ORBIT_HOME and the path given", got)
	}
}

// Storage that does not answer must not hold a report back for ever: the sync is waited for up to
// its timeout, then the report goes on and the log says so.
func TestVolumeSyncDoesNotHoldAReportOnStorageThatDoesNotAnswer(t *testing.T) {
	withManagedInstance(t, "4", testManagedPodUID)
	t.Setenv("ORBIT_HOME", t.TempDir())
	release := make(chan struct{})
	saved, savedTimeout := syncFilesystems, managedVolumeSyncTimeout
	syncFilesystems = func([]string) error { <-release; return nil }
	managedVolumeSyncTimeout = 50 * time.Millisecond
	t.Cleanup(func() { close(release); syncFilesystems, managedVolumeSyncTimeout = saved, savedTimeout })

	started := time.Now()
	logs := captureLogs(t, func() { syncManagedVolume("a turn") })
	if took := time.Since(started); took > 5*time.Second {
		t.Fatalf("the report waited %s for a sync that never returned", took)
	}
	if !strings.Contains(logs, "volume sync after a turn still running") {
		t.Fatalf("the log does not say the report went on without the sync: %q", logs)
	}
}

// Behind a tool, the sync runs without the caller waiting, one at a time; nudges while one runs
// give exactly one more, which starts after them, so what was written before any nudge is synced.
func TestBackgroundVolumeSyncCoalescesAndCoversEveryNudge(t *testing.T) {
	withManagedInstance(t, "4", testManagedPodUID)
	volumeSharedAs(t, false)
	home := t.TempDir()
	t.Setenv("ORBIT_HOME", home)
	started, release := make(chan int, 8), make(chan struct{})
	var mu sync.Mutex
	runs := 0
	saved := syncFilesystems
	syncFilesystems = func(paths []string) error {
		if len(paths) != 1 || paths[0] != home {
			t.Errorf("a background sync named %v, want ORBIT_HOME", paths)
		}
		mu.Lock()
		runs++
		n := runs
		mu.Unlock()
		started <- n
		<-release
		return nil
	}
	t.Cleanup(func() { syncFilesystems = saved })
	background := &backgroundVolumeSync{}

	returned := make(chan struct{})
	go func() { background.nudge(); close(returned) }()
	select {
	case <-returned:
	case <-time.After(5 * time.Second):
		t.Fatal("a nudge waited for the sync")
	}
	if n := <-started; n != 1 {
		t.Fatalf("sync %d started first", n)
	}
	for i := 0; i < 3; i++ {
		background.nudge() // while the first runs: one more after it, not three
	}
	release <- struct{}{}
	if n := <-started; n != 2 {
		t.Fatalf("sync %d started second", n)
	}
	release <- struct{}{}
	select {
	case n := <-started:
		t.Fatalf("sync %d ran, though nothing nudged after the second began", n)
	case <-time.After(100 * time.Millisecond):
	}
	background.nudge() // after the last returned: a new one
	if n := <-started; n != 3 {
		t.Fatalf("sync %d started third", n)
	}
	release <- struct{}{}
	deadline := time.Now().Add(5 * time.Second)
	for {
		background.mu.Lock()
		idle := !background.running
		background.mu.Unlock()
		if idle {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the background sync never went idle")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// On a volume that shares its filesystem (a Docker local volume) a sync writes back everything on the
// host's disk: the runner syncs before it reports, and not behind every tool.
func TestASharedVolumeIsSyncedBeforeReportsOnly(t *testing.T) {
	withManagedInstance(t, "4", testManagedPodUID)
	home := t.TempDir()
	t.Setenv("ORBIT_HOME", home)
	syncs := recordVolumeSyncs(t)
	volumeSharedAs(t, true)

	background := &backgroundVolumeSync{}
	for i := 0; i < 3; i++ {
		background.nudge()
	}
	time.Sleep(20 * time.Millisecond)
	if syncs.count() != 0 {
		t.Fatalf("a shared volume was synced %d times behind tools", syncs.count())
	}
	worktree := filepath.Join(t.TempDir(), "wt")
	syncManagedVolume("a turn", worktree)
	if syncs.count() != 1 || len(syncs.syncs[0]) != 2 || syncs.syncs[0][0] != home || syncs.syncs[0][1] != worktree {
		t.Fatalf("before a report a shared volume was synced as %v, want once, ORBIT_HOME and the path given", syncs.syncs)
	}
}
