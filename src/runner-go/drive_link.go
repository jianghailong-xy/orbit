package main

import (
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// ensureDriveLink makes ~/Drive the drive on a runner that receives it (docs/drive-technical-design.md §6.1): /home/orbit/Drive a symlink to /run/orbit-drive/drive, the mount the CSI plugin keeps below the
// plain /run/orbit-drive directory (/run/orbit-documents or /run/orbit-files in a Pod of an older driver: driveParentPath).
// Made at every start, so a link an agent removed is back after the runner restarts (§5.9 row 61). Whatever else is at
// that name is kept, as Drive.local-<time>, and the move logged. A runner without any of these directories (every
// self-registered one) is not touched.
// isDriveLinkTarget reports whether a link pointing at target was made to the drive: the mount, or a mount an older
// driver had.
func isDriveLinkTarget(target string) bool {
	if target == driveMountPath {
		return true
	}
	for _, old := range driveStaleLinkTargets {
		if target == old {
			return true
		}
	}
	return false
}

func ensureDriveLink(logf func(format string, args ...interface{})) {
	if info, err := os.Stat(filepath.Dir(driveMountPath)); err != nil || !info.IsDir() {
		return
	}
	for _, stale := range driveStaleHomePaths {
		if target, err := os.Readlink(stale); err == nil && isDriveLinkTarget(target) {
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
