//go:build !linux && !darwin

package main

import "errors"

// secretFilesSupported is false where 0600 has no meaning; such a runner does not declare owner-secret/v1.
const secretFilesSupported = false

var errSecretFilesUnsupported = errors.New("this runner's operating system cannot hold a secret file")

func writeSecretFile(*secretFileTarget, []byte, func(string) error, func(uint64, uint64) error) (uint64, uint64, error) {
	return 0, 0, errSecretFilesUnsupported
}

type secretFileState int

const (
	secretFileGone secretFileState = iota
	secretFileOurs
	secretFileReplaced
)

func inspectSecretFile(string, uint64, uint64) (secretFileState, int64) { return secretFileGone, 0 }

func unlinkSecretFile(string, uint64, uint64) (secretFileState, error) { return secretFileGone, nil }

func removeEmptySecretParents([]string) {}
