//go:build !linux && !darwin

package main

import (
	"errors"
	"os"
)

// platformCloneFile is cloneFile where the runner knows no way to clone a file: every checkout is written by git.
func platformCloneFile(src, dst string, perm os.FileMode) error { return errors.ErrUnsupported }
