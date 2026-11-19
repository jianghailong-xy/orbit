//go:build linux || darwin

package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"golang.org/x/sys/unix"
)

// secretFilesSupported is whether this build can hold a FILE secret: 0600 means something here.
const secretFilesSupported = true

// writeSecretFile writes value to target as a new 0600 file. It goes down from the home one directory at a time with
// O_NOFOLLOW, so a link anywhere below the home, put there before or after checkSecretFilePath looked, fails the write
// rather than moving it; a missing directory is created 0700, and recordParent is called before each one is, so the
// ledger knows about it first. The file is created O_CREAT|O_EXCL|O_NOFOLLOW: nothing that stands at the name, a link
// included, is ever opened. recordFile is called with the new file's device and inode BEFORE the value is written, so
// a crash leaves at worst an empty file the ledger can tell is its own.
func writeSecretFile(target *secretFileTarget, value []byte, recordParent func(dir string) error,
	recordFile func(dev, ino uint64) error) (dev, ino uint64, err error) {
	dirfd, err := unix.Open(target.home, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return 0, 0, fmt.Errorf("open the home directory: %w", err)
	}
	defer func() { unix.Close(dirfd) }()
	at := target.home
	for _, part := range target.rel[:len(target.rel)-1] {
		at = filepath.Join(at, part)
		next, err := unix.Openat(dirfd, part, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		if errors.Is(err, unix.ENOENT) {
			if err := recordParent(at); err != nil {
				return 0, 0, err
			}
			if err := unix.Mkdirat(dirfd, part, 0o700); err != nil && !errors.Is(err, unix.EEXIST) {
				return 0, 0, fmt.Errorf("create %s: %w", at, err)
			}
			next, err = unix.Openat(dirfd, part, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
			if err == nil {
				// Whatever the umask made of it.
				_ = unix.Fchmod(next, 0o700)
			}
		}
		if errors.Is(err, unix.ELOOP) || errors.Is(err, unix.ENOTDIR) {
			return 0, 0, secretPathRefusal(secretPathCodeLink, "goes through a symbolic link or a non-directory at %s", at)
		}
		if err != nil {
			return 0, 0, fmt.Errorf("open %s: %w", at, err)
		}
		unix.Close(dirfd)
		dirfd = next
	}
	leaf := target.rel[len(target.rel)-1]
	fd, err := unix.Openat(dirfd, leaf, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0o600)
	if errors.Is(err, unix.EEXIST) {
		return 0, 0, secretPathRefusal(secretPathCodeExists, "%q already exists", target.path)
	}
	if err != nil {
		return 0, 0, fmt.Errorf("create %s: %w", target.path, err)
	}
	file := os.NewFile(uintptr(fd), target.path)
	fail := func(err error) (uint64, uint64, error) {
		file.Close()
		_ = unix.Unlinkat(dirfd, leaf, 0)
		return 0, 0, err
	}
	if err := unix.Fchmod(fd, 0o600); err != nil {
		return fail(fmt.Errorf("chmod %s: %w", target.path, err))
	}
	var st unix.Stat_t
	if err := unix.Fstat(fd, &st); err != nil {
		return fail(fmt.Errorf("stat %s: %w", target.path, err))
	}
	dev, ino = uint64(st.Dev), uint64(st.Ino)
	if err := recordFile(dev, ino); err != nil {
		return fail(err)
	}
	if _, err := file.Write(value); err != nil {
		return fail(fmt.Errorf("write %s: %w", target.path, err))
	}
	if err := file.Sync(); err != nil {
		return fail(fmt.Errorf("sync %s: %w", target.path, err))
	}
	if err := file.Close(); err != nil {
		_ = unix.Unlinkat(dirfd, leaf, 0)
		return 0, 0, fmt.Errorf("close %s: %w", target.path, err)
	}
	return dev, ino, nil
}

// secretFileState is what stands at a ledger entry's path.
type secretFileState int

const (
	secretFileGone secretFileState = iota
	// The regular file at the recorded device and inode: the one the runner wrote.
	secretFileOurs
	// Something else: another file, a link, a directory.
	secretFileReplaced
)

// inspectSecretFile says what stands at path, against the device and inode the ledger recorded, and its size.
func inspectSecretFile(path string, dev, ino uint64) (secretFileState, int64) {
	var st unix.Stat_t
	if err := unix.Lstat(path, &st); err != nil {
		if errors.Is(err, unix.ENOENT) {
			return secretFileGone, 0
		}
		return secretFileReplaced, 0
	}
	if st.Mode&unix.S_IFMT != unix.S_IFREG || uint64(st.Dev) != dev || uint64(st.Ino) != ino {
		return secretFileReplaced, st.Size
	}
	return secretFileOurs, st.Size
}

// unlinkSecretFile removes path only when it is still the regular file at dev and ino. The test and the unlink go
// through one handle on the parent directory, so the directory cannot be swapped between them. It reports what it found.
func unlinkSecretFile(path string, dev, ino uint64) (secretFileState, error) {
	dirfd, err := unix.Open(filepath.Dir(path), unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if errors.Is(err, unix.ENOENT) {
		return secretFileGone, nil
	}
	if err != nil {
		return secretFileReplaced, nil
	}
	defer unix.Close(dirfd)
	leaf := filepath.Base(path)
	var st unix.Stat_t
	if err := unix.Fstatat(dirfd, leaf, &st, unix.AT_SYMLINK_NOFOLLOW); err != nil {
		if errors.Is(err, unix.ENOENT) {
			return secretFileGone, nil
		}
		return secretFileReplaced, nil
	}
	if st.Mode&unix.S_IFMT != unix.S_IFREG || uint64(st.Dev) != dev || uint64(st.Ino) != ino {
		return secretFileReplaced, nil
	}
	if err := unix.Unlinkat(dirfd, leaf, 0); err != nil && !errors.Is(err, unix.ENOENT) {
		return secretFileOurs, err
	}
	return secretFileOurs, nil
}

// removeEmptySecretParents removes the directories the runner created for a file, deepest first, each only if it is
// still an empty directory. rmdir does not follow a link at the name.
func removeEmptySecretParents(parents []string) {
	for i := len(parents) - 1; i >= 0; i-- {
		_ = unix.Rmdir(parents[i])
	}
}
