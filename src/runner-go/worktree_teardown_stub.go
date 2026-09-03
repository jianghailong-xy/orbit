//go:build !linux

package main

// teardownWorktreeProcesses is a no-op away from Linux: the match it needs — a process's working
// directory — is read from /proc, and no substitute is implemented here. Removal behaves exactly
// as it did before on those platforms: the directory goes, anything parked in it stays.
func teardownWorktreeProcesses(path string) {}
