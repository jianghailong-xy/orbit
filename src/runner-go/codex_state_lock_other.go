//go:build !linux && !darwin

package main

import "context"

// Linux and macOS are the distributed runner targets. Keep unsupported local
// builds functional; their in-process singleflight still prevents duplicate work.
func acquireCodexStateInitFileLock(_ context.Context, _ string) (func(), error) {
	return func() {}, nil
}
