//go:build !go1.25

package main

import (
	"errors"
	"io"
)

// Older toolchains have no rename inside an os.Root, so a save could not be held to the directory it was checked in.
// Fail closed. Released binaries are built with a newer Go (src/web/Dockerfile).
func saveLocalFile(string, []string, string, func(io.Writer) error) (string, error) {
	return "", errors.New("this build of Orbit cannot save a file safely: update the runner")
}
