//go:build linux

package main

import (
	"os"
	"syscall"
)

// ficlone is FICLONE, _IOW(0x94, 9, int): called on one file with another's descriptor, it makes the first share all
// of the second's blocks (XFS with reflink=1, btrfs, OpenZFS 2.2 and later with block cloning). Any other filesystem
// answers EOPNOTSUPP, and two filesystems EXDEV.
const ficlone = 0x40049409

// platformCloneFile is cloneFile on Linux: it creates dst with perm, which the umask does not narrow, and clones src
// into it with FICLONE. A dst it created and could not clone into is removed again.
func platformCloneFile(src, dst string, perm os.FileMode) (err error) {
	in, err := os.OpenFile(src, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, perm)
	if err != nil {
		return err
	}
	defer func() {
		if closeErr := out.Close(); err == nil {
			err = closeErr
		}
		if err != nil {
			_ = os.Remove(dst)
		}
	}()
	for {
		_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, out.Fd(), ficlone, in.Fd())
		if errno == syscall.EINTR {
			continue
		}
		if errno != 0 {
			return errno
		}
		break
	}
	return out.Chmod(perm)
}
