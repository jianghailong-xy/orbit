//go:build linux || darwin

package main

import "syscall"

// diskUsage reports the free and total bytes of the filesystem holding `path`.
//
// Free is Bavail, not Bfree: Bfree counts the blocks reserved for root, which an agent process
// cannot write to. Reporting those would let a gate wave a run through onto a disk it will
// immediately fail to write on — the one mistake this figure exists to prevent.
//
// Bsize is int64 on Linux and uint32 on Darwin, hence the conversion; both are non-negative in
// practice, and a zero block size (which no real filesystem reports) is treated as unusable
// rather than multiplied out to a nonsense zero.
func diskUsage(path string) (free uint64, total uint64, ok bool) {
	var fs syscall.Statfs_t
	if err := syscall.Statfs(path, &fs); err != nil {
		return 0, 0, false
	}
	bsize := uint64(fs.Bsize)
	if bsize == 0 {
		return 0, 0, false
	}
	return fs.Bavail * bsize, fs.Blocks * bsize, true
}
