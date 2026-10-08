package main

// Kimi Code's token-refresh lock, taken the way Kimi Code takes it.
//
// A Kimi Code access token lives 900 seconds, and refreshing it rotates the refresh token: the one
// sent is spent, and a process that does not store the pair it got back signs the account out. So
// every Kimi Code process sharing a KIMI_CODE_HOME refreshes under one lock and re-reads the stored
// token once it holds it, using what another process stored meanwhile rather than refreshing again
// (OAuthManager.doEnsureFresh, 2.1.1). The lock is proper-lockfile 4.1.2's on the file
// `<home>/oauth/<storage name>` (acquireRefreshLock), with stale 5000, realpath false and retries
// {retries: 120, factor: 1, minTimeout: 500}:
//
//   - the lock is the directory `<file>.lock`, held by whoever's mkdir made it;
//   - its holder keeps setting its mtime while it holds it, and gives it up by removing it;
//   - one whose mtime is more than five seconds old has been abandoned: it is removed and taken —
//     once per attempt, so two waiters never take turns removing each other's;
//   - a holder that finds the mtime is no longer the one it set has lost the lock to such a taker.
//
// The runner's usage read (kimi_usage.go) refreshes a token only while it holds this lock, so to a
// Kimi Code process it is one more Kimi Code process.

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sync/atomic"
	"time"
)

var (
	// kimiRefreshLockStale is how long a lock's mtime may stand still before it counts as abandoned.
	kimiRefreshLockStale = 5 * time.Second
	// kimiRefreshLockUpdate is how often a held lock's mtime is set. proper-lockfile sets it every
	// stale/2; anything well under kimiRefreshLockStale keeps the lock, and more often leaves a slow
	// tick less room to lose it.
	kimiRefreshLockUpdate = time.Second
	// The CLI's wait for a held lock: 120 retries, 500 milliseconds apart — a minute.
	kimiRefreshLockRetries    = 120
	kimiRefreshLockRetryDelay = 500 * time.Millisecond
)

var errKimiRefreshLockHeld = errors.New("Kimi Code's token refresh lock is held by another process")

// kimiRefreshLock is the lock while this process holds it.
type kimiRefreshLock struct {
	dir  string
	stop chan struct{}
	done chan struct{}
	lost atomic.Bool
}

// kimiRefreshLockDir is the lock directory of the token stored as `storage` in home.
func kimiRefreshLockDir(home, storage string) string {
	return filepath.Join(home, "oauth", storage+".lock")
}

// acquireKimiRefreshLock waits for the refresh lock of the token stored as `storage` in home, as long
// as the CLI waits for it, or until ctx ends.
func acquireKimiRefreshLock(ctx context.Context, home, storage string) (*kimiRefreshLock, error) {
	// The CLI makes oauth/ as it first locks. Mkdir, not MkdirAll: a home that is gone — an account
	// removed while it was being read — is not made again just to be locked in.
	if err := os.Mkdir(filepath.Join(home, "oauth"), 0o700); err != nil && !errors.Is(err, fs.ErrExist) {
		return nil, err
	}
	dir := kimiRefreshLockDir(home, storage)
	for attempt := 0; ; attempt++ {
		mtime, err := takeKimiRefreshLock(dir)
		if err == nil {
			l := &kimiRefreshLock{dir: dir, stop: make(chan struct{}), done: make(chan struct{})}
			go l.keepFresh(mtime)
			return l, nil
		}
		if !errors.Is(err, errKimiRefreshLockHeld) || attempt >= kimiRefreshLockRetries {
			return nil, err
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(kimiRefreshLockRetryDelay):
		}
	}
}

// takeKimiRefreshLock is one attempt at the lock (proper-lockfile's acquireLock), returning the mtime
// it set.
func takeKimiRefreshLock(dir string) (time.Time, error) {
	takeOver := true
	for {
		err := os.Mkdir(dir, 0o777)
		if err == nil {
			mtime, err := touchKimiRefreshLock(dir)
			if err != nil {
				_ = os.Remove(dir)
			}
			return mtime, err
		}
		if !errors.Is(err, fs.ErrExist) {
			return time.Time{}, err
		}
		if !takeOver {
			return time.Time{}, errKimiRefreshLockHeld
		}
		takeOver = false
		info, err := os.Stat(dir)
		if errors.Is(err, fs.ErrNotExist) {
			continue // released between the two: one more mkdir, taking nothing over
		}
		if err != nil {
			return time.Time{}, err
		}
		if !info.ModTime().Before(time.Now().Add(-kimiRefreshLockStale)) {
			return time.Time{}, errKimiRefreshLockHeld
		}
		if err := os.Remove(dir); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return time.Time{}, err
		}
	}
}

// touchKimiRefreshLock sets the lock's mtime to now and returns it as the filesystem keeps it, which
// is what the next look at it is compared with.
func touchKimiRefreshLock(dir string) (time.Time, error) {
	now := time.Now()
	if err := os.Chtimes(dir, now, now); err != nil {
		return time.Time{}, err
	}
	info, err := os.Stat(dir)
	if err != nil {
		return time.Time{}, err
	}
	return info.ModTime(), nil
}

// keepFresh sets the lock's mtime every kimiRefreshLockUpdate until release, and stops for good once
// the lock is not the one it last set: someone took it as abandoned, and it is theirs now.
func (l *kimiRefreshLock) keepFresh(mtime time.Time) {
	defer close(l.done)
	ticker := time.NewTicker(kimiRefreshLockUpdate)
	defer ticker.Stop()
	for {
		select {
		case <-l.stop:
			return
		case <-ticker.C:
		}
		info, err := os.Stat(l.dir)
		if err == nil && info.ModTime().Equal(mtime) {
			if mtime, err = touchKimiRefreshLock(l.dir); err == nil {
				continue
			}
		}
		l.lost.Store(true)
		return
	}
}

// held reports whether the lock is still this process's.
func (l *kimiRefreshLock) held() bool { return !l.lost.Load() }

// release gives the lock up. One lost to another process is left alone: the directory is theirs.
func (l *kimiRefreshLock) release() {
	close(l.stop)
	<-l.done
	if l.held() {
		_ = os.Remove(l.dir)
	}
}
