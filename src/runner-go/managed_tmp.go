package main

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// A managed runner's /tmp.
//
// /tmp is a directory of the runner's data volume: a subPath of the PVC on Kubernetes, a Subpath of the data
// volume on Docker (src/apiserver/src/managed-runners). Filled, it gives the writer ENOSPC, where the emptyDir
// it replaced got the whole Pod evicted by the kubelet and the Docker tmpfs counted against the container's
// memory. Unlike them it outlives the container, so the runner empties it itself:
//
//   - at daemon start, everything in it: the processes that wrote it ended with the container before this one
//     (sweepManagedTmpAtStart);
//   - when a session ends and nothing else is running here — no turn, no engine, no background job — what is
//     left of the work that ran (sweepManagedTmpWhenIdle).
//
// Only where /tmp is the volume's own directory for it, home/.orbit-tmp: a runner whose /tmp is a tmpfs or an
// emptyDir (an earlier template), or any self-managed machine, is never swept.

// managedTmpDir is the temporary directory a managed runner's template mounts.
const managedTmpDir = "/tmp"

// tmpSweepQuiet is how long an entry must have gone unwritten before the idle sweep takes it: what the daemon
// itself is writing in /tmp at that moment (a temporary index, a commit message) is kept.
const tmpSweepQuiet = 2 * time.Minute

// tmpSweepResult is what one sweep did.
type tmpSweepResult struct {
	removed, kept, failed int
	firstErr              error
}

func (r tmpSweepResult) String() string {
	line := fmt.Sprintf("removed %d entries", r.removed)
	if r.kept > 0 {
		line += fmt.Sprintf(", kept %d", r.kept)
	}
	if r.failed > 0 {
		line += fmt.Sprintf(", could not remove %d (%v)", r.failed, r.firstErr)
	}
	return line
}

// sweepTmp removes each entry of dir that keep does not keep, a directory with everything in it. It never
// follows a symlink: a link is removed as a link.
func sweepTmp(dir string, keep func(name string, path string, info fs.FileInfo) bool) (tmpSweepResult, error) {
	var result tmpSweepResult
	entries, err := os.ReadDir(dir)
	if err != nil {
		return result, err
	}
	for _, entry := range entries {
		path := filepath.Join(dir, entry.Name())
		info, err := os.Lstat(path)
		if err != nil {
			continue // gone already
		}
		if keep != nil && keep(entry.Name(), path, info) {
			result.kept++
			continue
		}
		if err := os.RemoveAll(path); err != nil {
			result.failed++
			if result.firstErr == nil {
				result.firstErr = err
			}
			continue
		}
		result.removed++
	}
	return result, nil
}

// keepWhileRunning is the idle sweep's rule: what the daemon keeps in /tmp for itself (the browser's display
// sockets and lock files, its process-group file, its own temporary files, all named orbit-*), sockets and
// pipes, which a live process listens on, and whatever was written in the last quiet period.
func keepWhileRunning(now time.Time, quiet time.Duration) func(string, string, fs.FileInfo) bool {
	return func(name, path string, info fs.FileInfo) bool {
		if strings.HasPrefix(name, "orbit-") || strings.HasPrefix(name, ".X") || name == ".ICE-unix" {
			return true
		}
		if info.Mode()&(fs.ModeSocket|fs.ModeNamedPipe|fs.ModeDevice|fs.ModeCharDevice) != 0 {
			return true
		}
		return !newestModification(path, info).Before(now.Add(-quiet))
	}
}

// newestModification is the latest modification time of path and, for a directory, of anything under it.
func newestModification(path string, info fs.FileInfo) time.Time {
	newest := info.ModTime()
	if !info.IsDir() {
		return newest
	}
	_ = filepath.WalkDir(path, func(_ string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if child, err := d.Info(); err == nil && child.ModTime().After(newest) {
			newest = child.ModTime()
		}
		return nil
	})
	return newest
}

// managedTmpSweepable says whether this process may sweep tmp: a managed runner whose tmp is its data volume's
// own temporary directory.
func managedTmpSweepable(tmp, home string) bool {
	return currentManagedInstance() != nil && isVolumeTmpDir(tmp, home)
}

// sweepManagedTmpAtStart empties a managed runner's /tmp as the daemon starts (sweepTmpAtStart).
func sweepManagedTmpAtStart(pool *sessionPool) {
	if managedTmpSweepable(managedTmpDir, os.Getenv("HOME")) {
		sweepTmpAtStart(pool, managedTmpDir)
	}
}

// sweepManagedTmpWhenIdle is the sweep a session's end makes in a managed runner's /tmp (sweepTmpWhenIdle).
func sweepManagedTmpWhenIdle(pool *sessionPool) {
	if managedTmpSweepable(managedTmpDir, os.Getenv("HOME")) {
		sweepTmpWhenIdle(pool, managedTmpDir, time.Now())
	}
}

// sweepTmpAtStart empties dir, unless a job handed on from the process before is still running here
// (pool.adoptRecordedJobs), whose files may be in it.
func sweepTmpAtStart(pool *sessionPool, dir string) {
	if pool.backgroundJobTotal() > 0 {
		logln("temporary directory: not emptied at start, a background job from the process before is still running")
		return
	}
	result, err := sweepTmp(dir, nil)
	if err != nil {
		logln("temporary directory: could not read", dir+":", err)
		return
	}
	logln("temporary directory", dir, "emptied at start:", result.String())
}

// sweepTmpWhenIdle removes what the work before left in dir (keepWhileRunning), when nothing runs here now.
func sweepTmpWhenIdle(pool *sessionPool, dir string, now time.Time) {
	if !pool.idleForTmpSweep() {
		return
	}
	result, err := sweepTmp(dir, keepWhileRunning(now, tmpSweepQuiet))
	if err != nil {
		logln("temporary directory: could not read", dir+":", err)
		return
	}
	if result.removed > 0 || result.failed > 0 {
		logln("temporary directory", dir, "swept after a session ended:", result.String())
	}
}

// managedTmpSubdir is the data volume's directory the template mounts at /tmp: home/.orbit-tmp.
const managedTmpSubdir = ".orbit-tmp"

// isVolumeTmpDir says whether tmp is home/.orbit-tmp itself: that directory is a real one, not a link, and tmp
// is the same directory. A link put in its place (pointing at the runner's state, say) is not swept through.
func isVolumeTmpDir(tmp, home string) bool {
	if tmp == "" || home == "" {
		return false
	}
	own, err := os.Lstat(filepath.Join(home, managedTmpSubdir))
	if err != nil || !own.IsDir() {
		return false
	}
	mounted, err := os.Stat(tmp)
	return err == nil && os.SameFile(own, mounted)
}
