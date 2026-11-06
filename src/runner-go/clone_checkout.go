package main

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
)

// Where the filesystem can clone files (APFS, XFS with reflink=1, btrfs, OpenZFS with block cloning), a session
// checkout is cloned from the workspace's own checkout, the template, instead of written out again: each file shares
// the template's blocks until one of the two is written, so a checkout costs next to nothing on disk
// (docs/session-checkout-storage-design.md §7). Anywhere else, and whenever cloning fails, git writes the checkout out
// as it always has. Files are never hardlinked between checkouts: a file rewritten in place (shell `>`, Node's
// writeFile) would change in every checkout at once, and each session's commit would carry the change into its branch.

// How the runner made a session's checkout (ClaimedSession.CheckoutCreation).
const (
	checkoutCloned = "cloned"
	checkoutPlain  = "plain"
)

func checkoutCreation(cloned bool) string {
	if cloned {
		return checkoutCloned
	}
	return checkoutPlain
}

// cloneFile makes dst, which must not exist yet, a clone of the regular file src: a file of its own with mode perm,
// whose data shares src's blocks until either is written. When the filesystem refuses the clone itself, the error is
// the bare errno, EOPNOTSUPP or EXDEV. A variable, so that a test can stand in a filesystem that clones (HPC's ext4
// disks cannot) or one that fails partway.
var cloneFile = platformCloneFile

// cloneProbes is what probing each filesystem answered, by device: nil where a file could be cloned, else why not.
// It lasts as long as the process does, so a runner that starts again probes again, and a worktrees root moved onto
// another filesystem is probed there.
var cloneProbes = struct {
	sync.Mutex
	byDevice map[uint64]error
}{byDevice: map[uint64]error{}}

// clonableFilesystem is the device of root's filesystem and whether files can be cloned there: nil when they can,
// else why not. root is the worktrees root; the runner asks at start, and before every checkout it makes.
func clonableFilesystem(root string) (uint64, error) {
	dev, err := fileDevice(root)
	if err != nil {
		return 0, err
	}
	cloneProbes.Lock()
	defer cloneProbes.Unlock()
	if answer, ok := cloneProbes.byDevice[dev]; ok {
		return dev, answer
	}
	answer := probeCloning(root)
	cloneProbes.byDevice[dev] = answer
	if answer == nil {
		logln("checkouts: the filesystem of", root, "can clone files, so session checkouts are cloned from their workspace's checkout")
	} else {
		logln("checkouts: the filesystem of", root, "cannot clone files ("+cloneFailure(answer)+"), so git writes out every session checkout")
	}
	return dev, answer
}

// probeCloning clones a file of its own in dir and says why that failed, or nil when it did not.
func probeCloning(dir string) error {
	src, err := os.CreateTemp(dir, ".orbit-clone-probe-*")
	if err != nil {
		return err
	}
	defer os.Remove(src.Name())
	// Enough bytes to need blocks of their own: btrfs keeps a file of a few hundred bytes inline in its metadata.
	_, err = src.Write(bytes.Repeat([]byte("orbit clone probe\n"), 4096))
	if closeErr := src.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	dst := src.Name() + ".clone"
	defer os.Remove(dst)
	return cloneFile(src.Name(), dst, 0o600)
}

// fileDevice is the device of the filesystem that holds path.
func fileDevice(path string) (uint64, error) {
	info, err := os.Stat(path)
	if err != nil {
		return 0, err
	}
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, fmt.Errorf("%s: no device number", path)
	}
	return uint64(st.Dev), nil
}

// cloneFailure is what err says about why a clone failed, in the system's own words where there are some, so that
// EOPNOTSUPP and EXDEV read as what they are.
func cloneFailure(err error) string {
	var errno syscall.Errno
	if errors.As(err, &errno) {
		return errno.Error()
	}
	return err.Error()
}

// whyNotCloned is why a session checkout cannot be cloned from template, the workspace's own checkout, or "" when it
// can: the worktrees root's filesystem cannot clone files, or the template is on another filesystem, where every
// clone would fail with EXDEV.
func whyNotCloned(template string) string {
	root := worktreesDir()
	dev, err := clonableFilesystem(root)
	if err != nil {
		return fmt.Sprintf("the filesystem of %s cannot clone files (%s)", root, cloneFailure(err))
	}
	templateDev, err := fileDevice(template)
	if err != nil {
		return fmt.Sprintf("the workspace's checkout cannot be read: %v", err)
	}
	if templateDev != dev {
		return fmt.Sprintf("the workspace's checkout %s is on another filesystem than %s", template, root)
	}
	return ""
}

// populateByCloning fills the checkout at wtPath, which `git worktree add --no-checkout` made and sparse rules may
// have narrowed, from template, the workspace's own checkout, and says how many files it cloned. It clones the regular
// files the checkout's own commit tracks that the template holds as regular files, and nothing else: untracked and
// ignored files never come along, and a path the template lacks, or holds as something else, is left to git.
//
// So are symlinks, which have no data to share. While the clones are made, the checkout holds nothing but directories
// and the files cloned into them, so no clone can go through a symlink to land outside the checkout. A symlink made
// here could: on a case-insensitive filesystem (APFS by default) a symlink A and a file a/x can both be in a commit.
// git writes the symlinks afterwards, and keeps any path from leading through one.
func populateByCloning(template, wtPath string) (int, error) {
	// An index of the checkout's own commit, made afresh. A copy of the template's would bring its marks along: an
	// assume-unchanged entry hides the session's edits from status and staging, and a skip-worktree one keeps a file
	// out of a full checkout while status reads clean (git 2.47.3).
	if _, err := git(wtPath, "read-tree", "HEAD"); err != nil {
		return 0, err
	}
	// This marks what the sparse rules leave out, and writes nothing: no file is on disk yet.
	if unboundedWorktreeGitOps.sparseCheckout(wtPath) {
		if _, err := git(wtPath, "sparse-checkout", "reapply"); err != nil {
			return 0, err
		}
	}
	entries, err := git(wtPath, "ls-files", "-s", "-t", "-z")
	if err != nil {
		return 0, err
	}
	cloned := 0
	made := map[string]bool{}
	for _, entry := range strings.Split(entries, "\x00") {
		if entry == "" {
			continue
		}
		// "<tag> <mode> <object> <stage>\t<path>": tag H for a path the checkout holds, S for one it leaves out.
		meta, path, ok := strings.Cut(entry, "\t")
		fields := strings.Fields(meta)
		if !ok || len(fields) != 4 {
			return cloned, fmt.Errorf("`git ls-files` listed %q", entry)
		}
		// Only regular files (100644, 100755) are cloned: git writes the symlinks (120000), and gives a submodule (a
		// gitlink, 160000) the empty directory it has in any checkout.
		if fields[0] != "H" || fields[1] != "100644" && fields[1] != "100755" {
			continue
		}
		src, dst := filepath.Join(template, path), filepath.Join(wtPath, path)
		info, err := os.Lstat(src)
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		if err := makeParentDir(dst, made); err != nil {
			return cloned, err
		}
		// The template's mode comes along; where its executable bit is not the commit's, the reset below writes the
		// file again.
		if err := cloneFile(src, dst, info.Mode().Perm()); err != nil {
			return cloned, fmt.Errorf("cloning %s: %w", path, err)
		}
		cloned++
	}
	// To git every clone is a new file, matching none of the stat data the index holds, and `reset --hard` writes out
	// again every entry whose stat data does not match its file. Refreshed first, an entry whose clone holds what the
	// commit does is matched, so the reset keeps that clone.
	if _, err := git(wtPath, "update-index", "-q", "--refresh"); err != nil {
		return cloned, err
	}
	// Whatever the clones do not hold as the commit has it, git writes: the template's edits, staged or not, what it
	// lacks, and whatever differs between the template's commit and this checkout's. So a checkout never depends on
	// the template being clean.
	if _, err := git(wtPath, "reset", "-q", "--hard"); err != nil {
		return cloned, err
	}
	return cloned, nil
}

// makeParentDir makes the directories path needs, as git does: mode 0777 less the umask. made remembers the ones
// already there.
func makeParentDir(path string, made map[string]bool) error {
	dir := filepath.Dir(path)
	if made[dir] {
		return nil
	}
	if err := os.MkdirAll(dir, 0o777); err != nil {
		return err
	}
	made[dir] = true
	return nil
}
