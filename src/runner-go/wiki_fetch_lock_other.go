//go:build !linux && !darwin

package main

import "time"

// Linux and macOS are the distributed runner targets. Keep unsupported local builds working: their
// fetches go without the lock, and a ref lock another fetch held is still tried again.
func acquireWikiFetchLock(string, time.Duration) (func(), bool) {
	return func() {}, false
}
