//go:build !go1.24

package main

import "os"

// Older toolchains cannot guarantee a read stays in the checkout during a
// symlink replacement. Keep legacy attachments available and fail closed here.
func openWorktreeArtifactFile(string, string, os.FileInfo) (*os.File, error) {
	return nil, errWorktreePreviewUnsupported
}
