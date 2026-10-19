package main

import (
	"fmt"
	"sync"
	"time"
)

// What a managed runner does so that its volume survives the power loss of its node
// (docs/managed-runner-design.md, "Implementation record: Git work and engine sessions through a
// power cut").
//
// Everything of a managed runner lives on one volume: the workspace's repository, the sessions'
// worktrees, the engines' homes with their session transcripts, the runner's own runs. What a power
// cut takes is what the page cache still held: ext4 writes delayed allocations back after about
// 30 s and makes a rename durable at its next journal commit, and neither Git nor the engines fsync
// most of what they write. A commit made 14 s before a cut came back as empty files and an
// unreadable repository (T02), and a turn answered 20 s before one was missing from the engine's
// transcript, so the next generation resumed without it (T08x).
//
// So a managed runner syncs the volume (syncfs: everything dirty on it, in one writeback and one
// journal commit):
//   - before it reports work that lives there: a turn's end, a session's end, a checkout it made, a
//     commit, a merge, a landing, a cleanup (syncManagedVolume). What the control plane has been
//     told about is then on the disk, whatever Git or an engine wrote;
//   - behind every tool an engine runs, in the background (volumeSyncAfterTools): a commit or an
//     edit in the middle of a turn is on the disk a sync's time after the tool returns.
//
// Not Git's own fsyncs (core.fsync=all): they cover objects, refs and the index but not HEAD,
// reflogs, config, worktree metadata or checked-out files, leave a command's last rename to the next
// journal commit, and pay one device round trip per file. On the lab's volumes that made a one-file
// commit 18 times and a 200-file commit 365 times slower; the same commit and a syncfs after it took
// a third of that for one file and a fiftieth for 200. A self-managed runner does neither: its
// filesystem is its owner's, shared with everything else they run, and what a sync costs there is
// theirs to decide.

// managedVolumeDurable reports whether this process makes its volume durable: a managed runner's
// only.
func managedVolumeDurable() bool { return currentManagedInstance() != nil }

// managedVolumeSyncTimeout bounds how long a report waits for the volume's sync. A sync returns once
// the volume's dirty data is on its disk: milliseconds, or seconds after a large write. One that
// takes longer is storage that is not answering, and holding the report back would not make
// anything more durable. A variable so a test need not wait it out.
var managedVolumeSyncTimeout = 30 * time.Second

// managedVolumeSlowSync is when a sync a report waited for is worth a line in the log.
const managedVolumeSlowSync = 5 * time.Second

// syncFilesystems writes back and commits the filesystems that hold paths, once each (syncfs on
// Linux). A variable so tests can see the syncs.
var syncFilesystems = syncFilesystemsOf

// syncManagedVolume makes everything written on this managed runner's volume durable before the
// runner reports work that lives there: the filesystem of ORBIT_HOME, and of each of paths that
// lives on another. Nothing for a self-managed runner. A failure or a timeout is logged, not
// returned: the report goes on either way, since the work it reports has happened.
func syncManagedVolume(reason string, paths ...string) {
	if !managedVolumeDurable() {
		return
	}
	started := time.Now()
	done := make(chan error, 1)
	go func() { done <- syncFilesystems(append([]string{machineHome()}, paths...)) }()
	select {
	case err := <-done:
		if err != nil {
			logln(fmt.Sprintf("volume sync after %s failed: %v", reason, err))
		} else if took := time.Since(started); took >= managedVolumeSlowSync {
			logln(fmt.Sprintf("volume sync after %s took %s", reason, took.Round(time.Millisecond)))
		}
	case <-time.After(managedVolumeSyncTimeout):
		logln(fmt.Sprintf("volume sync after %s still running after %s; reporting without it", reason, managedVolumeSyncTimeout))
	}
}

// backgroundVolumeSync syncs the volume each time it is nudged, without the caller waiting: one sync
// at a time, and a nudge during one runs one more after it, so whatever was written before any
// nudge is on the disk once a sync has started after it and returned.
type backgroundVolumeSync struct {
	mu      sync.Mutex
	running bool
	again   bool
}

// volumeSyncAfterTools is nudged by every tool result an engine reports (runInteractiveSession).
var volumeSyncAfterTools = &backgroundVolumeSync{}

func (b *backgroundVolumeSync) nudge() {
	if !managedVolumeDurable() {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.running {
		b.again = true
		return
	}
	b.running = true
	go b.run()
}

func (b *backgroundVolumeSync) run() {
	for {
		if err := syncFilesystems([]string{machineHome()}); err != nil {
			logln("volume sync after a tool's result failed:", err)
		}
		b.mu.Lock()
		if !b.again {
			b.running = false
			b.mu.Unlock()
			return
		}
		b.again = false
		b.mu.Unlock()
	}
}
