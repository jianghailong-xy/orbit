//go:build linux || darwin

package main

import (
	"context"
	"errors"
	"os"
	"sync"
	"syscall"
	"time"
)

const codexStateLockPollInterval = 100 * time.Millisecond

// acquireCodexStateInitFileLock serializes cold bootstrap across a background
// service and an accidental foreground runner sharing ORBIT_HOME. flock is
// advisory and tied to the open descriptor, so crashes release it automatically.
func acquireCodexStateInitFileLock(ctx context.Context, path string) (func(), error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, configFilePerm)
	if err != nil {
		return nil, err
	}
	if err := f.Chmod(configFilePerm); err != nil {
		_ = f.Close()
		return nil, err
	}
	for {
		err = syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			var once sync.Once
			return func() {
				once.Do(func() {
					_ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
					_ = f.Close()
				})
			}, nil
		}
		if !errors.Is(err, syscall.EWOULDBLOCK) && !errors.Is(err, syscall.EAGAIN) {
			_ = f.Close()
			return nil, err
		}
		timer := time.NewTimer(codexStateLockPollInterval)
		select {
		case <-ctx.Done():
			if !timer.Stop() {
				<-timer.C
			}
			_ = f.Close()
			return nil, ctx.Err()
		case <-timer.C:
		}
	}
}
