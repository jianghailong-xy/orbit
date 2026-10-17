//go:build linux || darwin

package main

import (
	"errors"
	"os"
	"sync"
	"syscall"
	"time"
)

// acquireWikiFetchLock takes the wiki fetch lock at path (fetchWikiOriginMain), waiting at most wait
// for whoever holds it. flock is tied to the open descriptor, not to the process: two goroutines of the
// runner exclude each other exactly as the runner and a CLI process in a session do, and a holder that
// dies lets go with its descriptors. held is false when the wait ran out or no lock could be taken at
// all, and the caller fetches without it.
func acquireWikiFetchLock(path string, wait time.Duration) (release func(), held bool) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDONLY, 0o644)
	if err != nil {
		return func() {}, false
	}
	deadline := time.Now().Add(wait)
	for {
		err = syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			var once sync.Once
			return func() {
				once.Do(func() {
					_ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
					_ = f.Close()
				})
			}, true
		}
		if (!errors.Is(err, syscall.EWOULDBLOCK) && !errors.Is(err, syscall.EAGAIN)) || !time.Now().Before(deadline) {
			_ = f.Close()
			return func() {}, false
		}
		time.Sleep(wikiFetchLockPoll)
	}
}
