//go:build windows

package main

import "os"

// enginePathWriteError asks whether this runner may replace the file at path, returning nil when
// it may. Windows has no access(2), and no code signature to invalidate by opening one for
// writing, so the writable open it has always used is the check here — see engineBinaryUpdatable.
func enginePathWriteError(path string) error {
	f, err := os.OpenFile(path, os.O_WRONLY, 0)
	if err != nil {
		return err
	}
	return f.Close()
}
