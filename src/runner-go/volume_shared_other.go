//go:build !linux

package main

// volumeFilesystemOf has nothing to tell off Linux: a managed runner runs in the Linux image, and only
// a managed runner syncs its volume.
func volumeFilesystemOf(string) (string, bool, error) { return "", false, nil }
