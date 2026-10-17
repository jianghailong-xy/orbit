//go:build go1.24

package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

// Anchor each directory to a handle. The already-resolved path must stay free of
// symlinks while it is opened; a concurrent replacement fails closed.
func openWorktreeArtifactFile(root, path string, rootInfo os.FileInfo) (*os.File, error) {
	base, err := os.OpenRoot(filepath.Dir(root))
	if err != nil {
		return nil, err
	}
	defer base.Close()
	parts := strings.Split(filepath.Join(filepath.Base(root), path), string(filepath.Separator))
	for i, part := range parts[:len(parts)-1] {
		before := rootInfo
		if i > 0 {
			before, err = base.Lstat(part)
			if err != nil {
				return nil, err
			}
		}
		if !before.IsDir() {
			return nil, errors.New("Worktree directory changed")
		}
		next, err := base.OpenRoot(part)
		if err != nil {
			return nil, err
		}
		defer next.Close()
		after, err := next.Stat(".")
		if err != nil || !os.SameFile(before, after) {
			return nil, errors.New("Worktree directory changed")
		}
		base = next
	}
	return base.OpenFile(parts[len(parts)-1], os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
}
