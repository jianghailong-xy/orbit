package main

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
)

// A workspace Orbit made in a new folder (POST /sessions newWorkspace.newFolder, docs/first-workspace-contract.md
// §4) is claimed with createWorkDir, and its workDir is made before the engine starts, but only inside this
// machine's home directory, symlinks resolved. The control plane named that folder: <reposRoot>/<name> for a runner
// that declares v1 only, <home>/<name> for one that declares v2, home being the directory the reported repos root
// sits in (clone.go). Both lie inside home, so the runner holds it to home: a path that resolves anywhere else,
// through a symlink or otherwise, is not made, and the session fails to start as one whose directory is missing does
// (startSessionProcess: "working directory … does not exist").
const (
	createWorkDirCapabilityV1 = "create-workdir/v1"
	createWorkDirCapabilityV2 = "create-workdir/v2"
)

// createOrbitWorkDir makes dir (mkdir -p, 0755) when it is missing and resolves inside home. Anything else is
// logged and left as it is.
func createOrbitWorkDir(sessionID, dir string) {
	if _, err := os.Stat(dir); !errors.Is(err, fs.ErrNotExist) {
		return // there already, or unreadable: nothing is made over it
	}
	target, err := orbitWorkDirTarget(dir)
	if err != nil {
		logln(fmt.Sprintf("session %s — not creating workDir %q: %v", sessionID, dir, err))
		return
	}
	if err := os.MkdirAll(target, 0o755); err != nil {
		logln(fmt.Sprintf("session %s — cannot create workDir %q: %v", sessionID, dir, err))
		return
	}
	logln(fmt.Sprintf("session %s — created workDir %q (createWorkDir)", sessionID, dir))
}

// orbitWorkDirTarget is the directory to make for dir, symlinks resolved, when it lies inside this machine's
// resolved home directory or its resolved repos root (which a link may put on another disk), and why not otherwise.
// It is made at the resolved path, so no link in the part that exists can carry the mkdir elsewhere.
func orbitWorkDirTarget(dir string) (string, error) {
	home := userHome()
	if home == "" {
		return "", errors.New("this machine has no home directory")
	}
	if !filepath.IsAbs(dir) {
		return "", errors.New("it is not an absolute path")
	}
	// The kernel applies `..` to where the links before it lead, which filepath.Clean cannot: the path judged and
	// made would not be the one the engine then runs in. Orbit names a single folder below home, never this.
	if slices.Contains(strings.Split(filepath.ToSlash(dir), "/"), "..") {
		return "", errors.New("it steps up with ..")
	}
	existing, missing, err := resolveExistingPart(dir)
	if err != nil {
		return "", err
	}
	target := filepath.Join(existing, missing)
	// Home: mkdir -p makes every missing directory below the nearest one that exists, so that one has to be home or
	// inside it, and home itself is never made.
	homeErr := insideRoot(home, existing, target, false)
	if homeErr == nil {
		return target, nil
	}
	// The repos root, where a v1 control plane names the folder: the root itself may still be made, in home.
	if insideRoot(reposRoot(), existing, target, true) == nil {
		return target, nil
	}
	return "", homeErr
}

// insideRoot says why target, whose nearest existing ancestor is existing, may not be made inside root, symlinks
// resolved; nil when it may. With mayMakeRoot, a root that does not exist yet is made along with it, but nothing
// above the root is.
func insideRoot(root, existing, target string, mayMakeRoot bool) error {
	rootExisting, rootMissing, err := resolveExistingPart(root)
	if err != nil {
		return err
	}
	resolvedRoot := filepath.Join(rootExisting, rootMissing)
	if target == resolvedRoot || !within(resolvedRoot, target) {
		return fmt.Errorf("it resolves to %s, which is not inside %s", target, resolvedRoot)
	}
	if !within(resolvedRoot, existing) && (!mayMakeRoot || existing != filepath.Dir(resolvedRoot)) {
		return fmt.Errorf("the directory %s does not exist", resolvedRoot)
	}
	return nil
}

// within reports whether path is root or below it.
func within(root, path string) bool {
	rel, err := filepath.Rel(root, path)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// resolveExistingPart splits path into its nearest existing ancestor, symlinks evaluated, and the rest below it,
// which does not exist yet and so holds no link. A link that leads nowhere is an error, not a directory to make.
func resolveExistingPart(path string) (existing, missing string, err error) {
	existing = filepath.Clean(path)
	for {
		_, err := os.Lstat(existing)
		if err == nil {
			break
		}
		parent := filepath.Dir(existing)
		if !errors.Is(err, fs.ErrNotExist) || parent == existing {
			return "", "", err
		}
		missing = filepath.Join(filepath.Base(existing), missing)
		existing = parent
	}
	resolved, err := filepath.EvalSymlinks(existing)
	if err != nil {
		return "", "", err
	}
	return resolved, missing, nil
}
