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
// machine's repos root, symlinks resolved. The control plane named that folder, <reposRoot>/<name> from the root this
// runner reports, so the runner holds it to that root: a path that resolves anywhere else, through a symlink or
// otherwise, is not made, and the session fails to start as one whose directory is missing does
// (startSessionProcess: "working directory … does not exist").
const createWorkDirCapabilityV1 = "create-workdir/v1"

// createOrbitWorkDir makes dir (mkdir -p, 0755) when it is missing and resolves inside the repos root. Anything
// else is logged and left as it is.
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
	logln(fmt.Sprintf("session %s — created workDir %q in the repos root (createWorkDir)", sessionID, dir))
}

// orbitWorkDirTarget is the directory to make for dir, symlinks resolved, when it lies inside this machine's
// resolved repos root, and why not otherwise. It is made at the resolved path, so no link in the part that
// exists can carry the mkdir elsewhere.
func orbitWorkDirTarget(dir string) (string, error) {
	root := reposRoot()
	if root == "" {
		return "", errors.New("this machine has no repos root")
	}
	if !filepath.IsAbs(dir) {
		return "", errors.New("it is not an absolute path")
	}
	// The kernel applies `..` to where the links before it lead, which filepath.Clean cannot: the path judged and
	// made would not be the one the engine then runs in. Orbit names a single folder below the root, never this.
	if slices.Contains(strings.Split(filepath.ToSlash(dir), "/"), "..") {
		return "", errors.New("it steps up with ..")
	}
	existing, missing, err := resolveExistingPart(dir)
	if err != nil {
		return "", err
	}
	rootExisting, rootMissing, err := resolveExistingPart(root)
	if err != nil {
		return "", err
	}
	resolvedRoot, target := filepath.Join(rootExisting, rootMissing), filepath.Join(existing, missing)
	if target == resolvedRoot || !within(resolvedRoot, target) {
		return "", fmt.Errorf("it resolves to %s, which is not inside the repos root %s", target, resolvedRoot)
	}
	// mkdir -p makes every missing directory below the nearest one that exists, so that one has to be the root,
	// inside it, or where the root itself is to be made: nothing above the root is made.
	if !within(resolvedRoot, existing) && existing != filepath.Dir(resolvedRoot) {
		return "", fmt.Errorf("the directory the repos root %s belongs in does not exist", resolvedRoot)
	}
	return target, nil
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
