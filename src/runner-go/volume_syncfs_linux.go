package main

import (
	"errors"
	"fmt"
	"os"
	"syscall"
)

// syncFilesystemsOf runs syncfs(2) once for each filesystem that holds one of paths: it writes back
// that filesystem's dirty data and commits its journal. That is the managed runner's volume and
// nothing else, where sync(2) would flush every filesystem of the node, other runners' volumes
// among them. A path that does not exist is skipped.
func syncFilesystemsOf(paths []string) error {
	synced := map[uint64]bool{}
	var errs []error
	for _, path := range paths {
		if path == "" {
			continue
		}
		f, err := os.Open(path)
		if err != nil {
			if !os.IsNotExist(err) {
				errs = append(errs, err)
			}
			continue
		}
		var st syscall.Stat_t
		if err := syscall.Fstat(int(f.Fd()), &st); err != nil {
			errs = append(errs, fmt.Errorf("stat %s: %w", path, err))
		} else if dev := uint64(st.Dev); !synced[dev] {
			synced[dev] = true
			if _, _, errno := syscall.Syscall(sysSyncfs, f.Fd(), 0, 0); errno != 0 {
				errs = append(errs, fmt.Errorf("syncfs %s: %w", path, errno))
			}
		}
		f.Close()
	}
	return errors.Join(errs...)
}
