//go:build windows

package main

// diskUsage has no stdlib answer on Windows (it needs GetDiskFreeSpaceExW through the syscall
// package, and this module carries no external dependencies). Reporting nothing is the correct
// degradation: the control plane reads an absent figure as "unknown" and leaves the disk gate
// off for this runner, exactly as it does for a runner too old to report at all. Guessing a
// number here would be worse than silence — it would gate real work on a fiction.
func diskUsage(string) (free uint64, total uint64, ok bool) {
	return 0, 0, false
}
