package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Out-of-band deduplication of a managed runner's own volume. A session checkout already shares its blocks with the
// workspace checkout it was cloned from (clone_checkout.go), but what a session writes itself does not: every
// `npm ci` in a checkout writes its own node_modules, byte for byte the same as the one next to it. duperemove finds
// those duplicates and has the kernel share them (FIDEDUPERANGE, which compares the bytes itself and shares nothing
// that differs), on a filesystem that can clone files: XFS with reflink=1 here.
//
// It runs in the runner's own process, on its own volume, so nothing outside the Pod ever holds the volume open: the
// single-writer rules of docs/managed-runner-design.md stay as they are, and a pass ends with the Pod's drain. Each
// user's volume is a filesystem of its own, so nothing is ever shared between two users.
//
// A pass starts once the runner has been idle for homeDedupeIdleDelay, after work of any kind (the volume may have
// changed) and at start (what an earlier generation wrote). It is counted among the workload report's operations, so
// the manager does not put the runner to sleep under it, and it is stopped the moment work comes back, or the process
// stops. Its hashfile lives on the volume, so the next pass re-reads only what changed since; one cut short resumes.

const (
	// One heartbeat of idle, and under the manager's shortest idle interval (lifecycle.idleSeconds, 60 at least): the
	// pass starts before the runner is asked to sleep, and holds that off until it ends.
	homeDedupeIdleDelay = 25 * time.Second
	// The longest one pass may hold off sleep. One cut short leaves its hashes behind, so the next resumes from them.
	homeDedupeBudget = 20 * time.Minute
	// How long a pass that failed waits before the next is tried.
	homeDedupeRetryDelay = 6 * time.Hour
)

// homeDedupe schedules the passes over one volume.
type homeDedupe struct {
	mu   sync.Mutex
	now  func() time.Time
	root string
	// hashfile is duperemove's record of what it has read; it lives under root and is left out of the scan.
	hashfile string
	// run runs one pass to the end, or until ctx ends.
	run func(ctx context.Context, root, hashfile string) error

	// dirty: the volume may hold what no pass has looked at yet.
	dirty      bool
	idleSince  time.Time
	retryAfter time.Time
	cancel     context.CancelFunc
	// pass is the running pass's number; 0 when none runs.
	pass, passes int
}

// newHomeDedupe is the scheduler for the volume at root, or nil when it cannot deduplicate: no duperemove, or a
// filesystem that cannot share blocks, which would only make every pass read the whole volume for nothing.
func newHomeDedupe(root string) *homeDedupe {
	if root == "" {
		return nil
	}
	if _, err := exec.LookPath("duperemove"); err != nil {
		logln("dedupe: off: duperemove is not installed")
		return nil
	}
	if _, err := clonableFilesystem(root); err != nil {
		logln("dedupe: off: the filesystem of", root, "cannot share blocks ("+errnoName(err)+")")
		return nil
	}
	logln("dedupe: on: duplicate files under", root, "are shared once the runner is idle")
	return &homeDedupe{
		now:      time.Now,
		root:     root,
		hashfile: filepath.Join(root, ".cache", "orbit", "duperemove.hash"),
		run:      runDuperemove,
		dirty:    true,
	}
}

// inFlight is 1 while a pass runs, for the workload report.
func (d *homeDedupe) inFlight() int {
	if d == nil {
		return 0
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.pass != 0 {
		return 1
	}
	return 0
}

// tick is called on every heartbeat with whether the runner is idle, not counting the pass itself, and free to start
// one: not stopping, and with no sleep request accepted. Work stops a running pass and marks the volume for the next.
func (d *homeDedupe) tick(idle bool) {
	if d == nil {
		return
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	now := d.now()
	if !idle {
		d.dirty = true
		d.idleSince = time.Time{}
		if d.cancel != nil {
			d.cancel()
			d.cancel = nil
		}
		return
	}
	if d.idleSince.IsZero() {
		d.idleSince = now
	}
	if d.pass != 0 || !d.dirty || now.Before(d.retryAfter) || now.Sub(d.idleSince) < homeDedupeIdleDelay {
		return
	}
	d.passes++
	pass := d.passes
	ctx, cancel := context.WithTimeout(context.Background(), homeDedupeBudget)
	d.pass, d.cancel, d.dirty = pass, cancel, false
	go d.finish(ctx, cancel, pass, now)
}

// stop ends a running pass; the volume is looked at again by the next process.
func (d *homeDedupe) stop() {
	if d == nil {
		return
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.cancel != nil {
		d.cancel()
		d.cancel = nil
	}
}

func (d *homeDedupe) finish(ctx context.Context, cancel context.CancelFunc, pass int, started time.Time) {
	defer cancel()
	err := d.run(ctx, d.root, d.hashfile)
	d.mu.Lock()
	defer d.mu.Unlock()
	took := d.now().Sub(started).Round(time.Second)
	switch {
	case errors.Is(ctx.Err(), context.DeadlineExceeded):
		// Its hashes stay behind: the next pass, after the next work, resumes from them.
		logln(fmt.Sprintf("dedupe: pass %d stopped at its %s budget; the next resumes from its hashes", pass, homeDedupeBudget))
	case ctx.Err() != nil:
		d.dirty = true
		logln(fmt.Sprintf("dedupe: pass %d stopped after %s: work came in, or the runner is stopping", pass, took))
	case err != nil:
		d.dirty = true
		d.retryAfter = d.now().Add(homeDedupeRetryDelay)
		logln(fmt.Sprintf("dedupe: pass %d failed after %s: %v; next try after %s", pass, took, err,
			d.retryAfter.UTC().Format(time.RFC3339)))
	default:
		logln(fmt.Sprintf("dedupe: pass %d done in %s", pass, took))
	}
	d.pass, d.cancel = 0, nil
}

// runDuperemove runs one duperemove pass over root at the lowest CPU and I/O priority, keeping its hashes in
// hashfile. Killed with its context; a range the kernel is sharing at that moment is shared whole or not at all.
func runDuperemove(ctx context.Context, root, hashfile string) error {
	if err := os.MkdirAll(filepath.Dir(hashfile), 0o700); err != nil {
		return err
	}
	// 4k blocks reach the small files node_modules is mostly made of (the default, 128k, skips every file under it),
	// and partial shares the parts two files have in common, not only whole extents that match.
	argv := []string{"duperemove", "-r", "-d", "-h", "-q", "-b", "4k", "--dedupe-options=partial",
		"--hashfile=" + hashfile, "--exclude=" + filepath.Dir(hashfile) + "/*", root}
	argv = append([]string{"nice", "-n", "19"}, argv...)
	if _, err := exec.LookPath("ionice"); err == nil {
		argv = append([]string{"ionice", "-c", "3"}, argv...)
	}
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	configureSessionProcessTree(cmd)
	out, err := cmd.CombinedOutput()
	if err != nil && ctx.Err() == nil {
		tail := strings.TrimSpace(string(out))
		if len(tail) > 400 {
			tail = tail[len(tail)-400:]
		}
		return fmt.Errorf("%v: %s", err, tail)
	}
	return err
}
