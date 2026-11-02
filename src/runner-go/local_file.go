package main

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// localFileScope is the one rule for a file of this machine on its way to the control plane, whichever door it leaves
// by: file_upload, a file a reply links, a legacy artifact request or Codex's generated image. It goes by where a path
// really is, with its links resolved, against roots resolved the same way, and open is the only way it hands a file on,
// so that what was judged is what is read.
//
// The doors need one rule because they share an end: file_list and file_fetch read back whatever a session's rows hold,
// so a door that read further than the others would widen all of them. These tools are also always allowed, with no
// prompt in any permission mode, and they run outside the engine's sandbox.
//
// Orbit's own directory is refused first and whatever the roots say: it holds the machine's credentials, kept in a file
// so that they stay out of the engine (cmdMcp), and a root can hold it.
type localFileScope struct {
	// Orbit's own directory (machineHome).
	home string
	// The roots inside it, which are the session's own.
	own []string
	// Where a path may be.
	roots []string
}

// The reasons a path is refused, which also say so to whoever reads a refusal.
const (
	localFileInOrbitsDirectory = "inside Orbit's own directory, which holds this machine's credentials"
	localFileOutsideTheSession = "outside this session's checkout and uploads directory"
)

// localFileRefused is the scope's answer for a path it will not read.
type localFileRefused struct{ reason string }

func (e *localFileRefused) Error() string { return "the path is " + e.reason }

// newLocalFileScope takes a session's own directories, which may be under Orbit's, and any other root, which never
// makes anything there readable. Orbit's directory itself, or one that holds it, is nobody's own.
func newLocalFileScope(sessionDirs []string, otherRoots ...string) localFileScope {
	home := realPath(machineHome())
	scope := localFileScope{home: home}
	for _, dir := range sessionDirs {
		real := realPath(dir)
		scope.roots = append(scope.roots, real)
		if real != home && pathInsideAny(real, home) {
			scope.own = append(scope.own, real)
		}
	}
	for _, dir := range otherRoots {
		scope.roots = append(scope.roots, realPath(dir))
	}
	return scope
}

// refuses says why a path, with its links resolved, may not be read, and "" when it may.
func (s localFileScope) refuses(real string) string {
	if pathInsideAny(real, s.home) && !pathInsideAny(real, s.own...) {
		return localFileInOrbitsDirectory
	}
	if !pathInsideAny(real, s.roots...) {
		return localFileOutsideTheSession
	}
	return ""
}

// open judges path and opens what it judged. The open goes down from the root a directory handle at a time and fails
// closed on a link or a replacement anywhere in the resolved path, and it does not block on a FIFO
// (openWorktreeArtifactFile). What is true of the file, its type and size and what sniffing it says, is read from the
// handle: the path may mean something else by then.
func (s localFileScope) open(path string) (*os.File, os.FileInfo, error) {
	real, err := filepath.EvalSymlinks(path)
	if err != nil {
		return nil, nil, err
	}
	if reason := s.refuses(real); reason != "" {
		return nil, nil, &localFileRefused{reason: reason}
	}
	for _, root := range s.roots {
		if !pathInsideAny(real, root) {
			continue
		}
		rootInfo, err := os.Lstat(root)
		if err != nil {
			return nil, nil, err
		}
		rel, err := filepath.Rel(root, real)
		if err != nil {
			return nil, nil, err
		}
		file, err := openWorktreeArtifactFile(root, rel, rootInfo)
		if err != nil {
			return nil, nil, err
		}
		info, err := file.Stat()
		if err == nil && !info.Mode().IsRegular() {
			err = errors.New("not a regular file")
		}
		if err != nil {
			file.Close()
			return nil, nil, err
		}
		return file, info, nil
	}
	return nil, nil, &localFileRefused{reason: localFileOutsideTheSession}
}

// realPath is the absolute path with its links resolved, or as it stands when it does not exist yet.
func realPath(path string) string {
	if abs, err := filepath.Abs(path); err == nil {
		path = abs
	}
	if real, err := filepath.EvalSymlinks(path); err == nil {
		return real
	}
	return filepath.Clean(path)
}

// pathInsideAny reports whether path is one of the roots or under one.
func pathInsideAny(path string, roots ...string) bool {
	for _, root := range roots {
		rel, err := filepath.Rel(root, path)
		if err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return true
		}
	}
	return false
}

// errLocalPathChanged is saveLocalFile's refusal: something it would have gone through is not the directory it should be.
var errLocalPathChanged = errors.New("a link or something other than a directory is in the way, so nothing was saved")

// checkLocalSaveTarget refuses a name that is already something other than a file, and is what makes a link at the last
// level a refusal like one at any other: a rename would only have replaced it.
func checkLocalSaveTarget(info os.FileInfo, err error) error {
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("%s: %w", info.Name(), errLocalPathChanged)
	}
	return nil
}
