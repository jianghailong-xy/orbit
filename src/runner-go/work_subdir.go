package main

import (
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
)

// A session with no worktree may run in a folder below its workspace's workDir (POST /sessions workSubdir: `orbit`
// typed in a subfolder of a workspace). The control plane checked its shape; only this machine can check the
// folder itself. It has to be there, and, symlinks followed, inside the workspace directory: a link that leads
// out of the workspace does not take the engine with it. Otherwise no engine starts and the run fails with
// workSubdirRefusal (runSessionProcess reports job.SourceRefusal).
const workSubdirRefusal = "WORK_SUBDIR_REFUSED"

// workSubdirExecDir is the directory a no-worktree session with a workSubdir runs in, symlinks resolved, or ""
// with job.SourceRefusal set saying why it may not run there.
func workSubdirExecDir(job *ClaimedSession, baseDir string) string {
	dir, err := resolveWorkSubdir(baseDir, job.WorkSubdir)
	if err != nil {
		return refuseSourceWorktree(job, workSubdirRefusal, err.Error())
	}
	job.IsolationStatus = isoShared
	logln(fmt.Sprintf("session %s — running in %s, below the workspace directory %s (workSubdir)", job.SessionID, dir, baseDir))
	return dir
}

// resolveWorkSubdir is workDir/sub with every symlink followed, when that is an existing directory inside workDir
// (itself resolved), and why not otherwise.
func resolveWorkSubdir(workDir, sub string) (string, error) {
	slashed := filepath.ToSlash(sub)
	if filepath.IsAbs(sub) || strings.HasPrefix(slashed, "/") || slices.Contains(strings.Split(slashed, "/"), "..") {
		return "", fmt.Errorf("the session's folder %q is not a path inside the workspace directory %s", sub, workDir)
	}
	root, err := filepath.EvalSymlinks(workDir)
	if err != nil {
		return "", fmt.Errorf("the workspace directory %s cannot be read: %v", workDir, err)
	}
	want := filepath.Join(workDir, filepath.FromSlash(sub))
	dir, err := filepath.EvalSymlinks(want)
	if err != nil {
		if os.IsNotExist(err) {
			return "", fmt.Errorf("the session's folder %s does not exist on this machine", want)
		}
		return "", fmt.Errorf("the session's folder %s cannot be read: %v", want, err)
	}
	rel, err := filepath.Rel(root, dir)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return "", fmt.Errorf("the session's folder %s leads to %s, outside the workspace directory %s", want, dir, root)
	}
	if fi, err := os.Stat(dir); err != nil || !fi.IsDir() {
		return "", fmt.Errorf("the session's folder %s is not a directory", want)
	}
	return dir, nil
}
