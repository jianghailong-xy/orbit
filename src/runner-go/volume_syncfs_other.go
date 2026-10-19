//go:build !linux

package main

// syncFilesystemsOf has nothing to do off Linux: a managed runner runs in the Linux image
// (deploy/managed-runner/image), and only a managed runner syncs its volume.
func syncFilesystemsOf([]string) error { return nil }
