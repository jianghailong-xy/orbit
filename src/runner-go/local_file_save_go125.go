//go:build go1.25

package main

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"syscall"
)

// saveLocalFile is the one way a file is written under a session's uploads directory: parent, then dirs, then name. An
// agent can write in that directory, and this runs with no prompt and outside any sandbox, so nothing in it is taken on
// trust: each directory is entered by a handle after checking what it is, creating it if it is missing, and the file is
// written beside its name and renamed into place only once fill has finished, so that an error leaves nothing that looks
// saved. A link at any level is a refusal, not a path to follow. parent is the runner's own, and is opened as it stands.
func saveLocalFile(parent string, dirs []string, name string, fill func(io.Writer) error) (string, error) {
	if err := os.MkdirAll(parent, 0o755); err != nil {
		return "", err
	}
	dir, err := os.OpenRoot(parent)
	if err != nil {
		return "", err
	}
	defer func() { dir.Close() }()
	for _, part := range dirs {
		next, err := enterLocalDir(dir, part)
		if err != nil {
			return "", fmt.Errorf("%s: %w", part, err)
		}
		dir.Close()
		dir = next
	}
	if err := checkLocalSaveTarget(dir.Lstat(name)); err != nil {
		return "", err
	}
	var token [8]byte
	if _, err := rand.Read(token[:]); err != nil {
		return "", err
	}
	temp := ".saving-" + hex.EncodeToString(token[:])
	file, err := dir.OpenFile(temp, os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW, 0o644)
	if err != nil {
		return "", err
	}
	// Gone already once the rename has happened.
	defer func() { _ = dir.Remove(temp) }()
	err = fill(file)
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return "", err
	}
	if err := dir.Rename(temp, name); err != nil {
		return "", err
	}
	return filepath.Join(append(append([]string{parent}, dirs...), name)...), nil
}

// enterLocalDir opens the directory called name inside dir, making it if it is missing. What was checked and what was
// entered are held to being the same directory, so a swap between the two is refused too.
func enterLocalDir(dir *os.Root, name string) (*os.Root, error) {
	if err := dir.Mkdir(name, 0o755); err != nil && !errors.Is(err, fs.ErrExist) {
		return nil, err
	}
	before, err := dir.Lstat(name)
	if err != nil {
		return nil, err
	}
	if !before.IsDir() {
		return nil, errLocalPathChanged
	}
	next, err := dir.OpenRoot(asDirectory(name))
	if err != nil {
		return nil, err
	}
	after, err := next.Stat(".")
	if err != nil || !os.SameFile(before, after) {
		next.Close()
		return nil, errLocalPathChanged
	}
	return next, nil
}
