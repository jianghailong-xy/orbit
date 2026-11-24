package main

import (
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// ensureDriveLink makes ~/Drive the Documents drive on a runner that receives it (docs/documents-drive-technical-
// design.md §6.1): /home/orbit/Drive a symlink to /run/orbit-documents/drive, the mount the CSI plugin keeps below the
// plain /run/orbit-documents directory (/run/orbit-files in a Pod of the driver from before the rename: driveParentPath).
// Made at every start, so a link an agent removed is back after the runner restarts (§5.9 row 61). Whatever else is at
// that name is kept, as Documents.local-<time>, and the move logged. A runner without either directory (every
// self-registered one) is not touched.
func ensureDriveLink(logf func(format string, args ...interface{})) {
	if info, err := os.Stat(filepath.Dir(driveMountPath)); err != nil || !info.IsDir() {
		return
	}
	for _, stale := range driveStaleHomePaths {
		if target, err := os.Readlink(stale); err == nil && target == driveMountPath {
			if err := os.Remove(stale); err == nil {
				logf("removed %s, a link to the drive an earlier runner made: the drive is %s", stale, driveHomePath)
			}
		}
	}
	if target, err := os.Readlink(driveHomePath); err == nil && target == driveMountPath {
		return
	}
	if _, err := os.Lstat(driveHomePath); err == nil {
		kept := fmt.Sprintf("%s.local-%s", driveHomePath, time.Now().UTC().Format("20060102T150405Z"))
		for n := 2; ; n++ {
			if _, err := os.Lstat(kept); os.IsNotExist(err) {
				break
			}
			kept = fmt.Sprintf("%s.local-%s-%d", driveHomePath, time.Now().UTC().Format("20060102T150405Z"), n)
		}
		if err := os.Rename(driveHomePath, kept); err != nil {
			logf("cannot make %s the Drive: moving what is there aside failed: %v", driveHomePath, err)
			return
		}
		logf("moved what was at %s to %s: %s is the Drive", driveHomePath, kept, driveHomePath)
	}
	if err := os.MkdirAll(filepath.Dir(driveHomePath), 0o755); err != nil {
		logf("cannot make %s the Drive: %v", driveHomePath, err)
		return
	}
	if err := os.Symlink(driveMountPath, driveHomePath); err != nil {
		logf("cannot make %s the Drive: %v", driveHomePath, err)
	}
}
