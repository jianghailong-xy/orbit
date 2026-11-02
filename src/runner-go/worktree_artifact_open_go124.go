//go:build go1.24

package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

var errWorktreeChanged = errors.New("Worktree directory changed")

// Anchor each directory to a handle, starting at the root. The already-resolved path must stay free of symlinks while
// it is opened; a concurrent replacement fails closed. os.Root alone does not give that: it follows a link that stays
// inside it, whatever the flags say, so what is opened at each level is held to what stood at that name. It starts at the
// root and never above it, where the directories beside this one are: another session's are there.
func openWorktreeArtifactFile(root, path string, rootInfo os.FileInfo) (*os.File, error) {
	base, err := os.OpenRoot(asDirectory(root))
	if err != nil {
		return nil, err
	}
	defer base.Close()
	if err := sameDirectory(base, rootInfo); err != nil {
		return nil, err
	}
	parts := strings.Split(filepath.Clean(path), string(filepath.Separator))
	for _, part := range parts[:len(parts)-1] {
		before, err := base.Lstat(part)
		if err != nil {
			return nil, err
		}
		next, err := base.OpenRoot(asDirectory(part))
		if err != nil {
			return nil, err
		}
		defer next.Close()
		if err := sameDirectory(next, before); err != nil {
			return nil, err
		}
		base = next
	}
	leaf := parts[len(parts)-1]
	before, err := base.Lstat(leaf)
	if err != nil {
		return nil, err
	}
	file, err := base.OpenFile(leaf, os.O_RDONLY|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, err
	}
	if after, err := file.Stat(); err != nil || !os.SameFile(before, after) {
		file.Close()
		return nil, errWorktreeChanged
	}
	return file, nil
}

// sameDirectory holds a directory just opened to what stood at its name.
func sameDirectory(opened *os.Root, before os.FileInfo) error {
	after, err := opened.Stat(".")
	if err != nil || !os.SameFile(before, after) {
		return errWorktreeChanged
	}
	return nil
}
