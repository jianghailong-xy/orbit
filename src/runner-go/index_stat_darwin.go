//go:build darwin

package main

import (
	"os"
	"syscall"
)

// clonedIndexStat is the stat data a git index holds for the file, as macOS reports it. Git stores 32-bit fields;
// the kernel's 64-bit seconds and inode numbers are truncated the same way.
func clonedIndexStat(info os.FileInfo) (indexStatData, bool) {
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return indexStatData{}, false
	}
	return indexStatData{
		ctimeSec:  uint32(st.Ctimespec.Sec),
		ctimeNsec: uint32(st.Ctimespec.Nsec),
		mtimeSec:  uint32(st.Mtimespec.Sec),
		mtimeNsec: uint32(st.Mtimespec.Nsec),
		dev:       uint32(st.Dev),
		ino:       uint32(st.Ino),
		uid:       st.Uid,
		gid:       st.Gid,
		size:      uint32(st.Size),
	}, true
}
