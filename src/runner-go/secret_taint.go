package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// A value is forgotten when its grant ends, but a commit that holds it does not go away with it. So while a value is
// still known — at the end of each turn of a session on a runner that holds any grant, and just before a grant is
// removed — every session checkout's own history (its tip, not its base) is scanned (secretHistoryScan), and a commit
// whose history holds a value is recorded here: the repository, the commit id and the paths, never the value or any
// hash of it. Every merge and push guard refuses a tip from which a recorded commit is reachable and the target is not
// (secretPushRefusal), with no grant held at all.

// secretTaintEntry is one recorded commit.
type secretTaintEntry struct {
	Repo       string    `json:"repo"` // the repository's common git directory
	Commit     string    `json:"commit"`
	Paths      []string  `json:"paths"`
	RecordedAt time.Time `json:"recordedAt"`
}

type secretTaintFile struct {
	Version int                `json:"version"`
	Entries []secretTaintEntry `json:"entries"`
}

var secretTaintMu sync.Mutex

func secretTaintPath() string { return filepath.Join(machineHome(), "secret-grants", "taint.json") }

func readSecretTaint() ([]secretTaintEntry, error) {
	data, err := os.ReadFile(secretTaintPath())
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var file secretTaintFile
	if err := json.Unmarshal(data, &file); err != nil {
		return nil, err
	}
	return file.Entries, nil
}

// writeSecretTaint writes the record whole (dir 0700, file 0600), through a renamed temporary file.
func writeSecretTaint(entries []secretTaintEntry) error {
	path := secretTaintPath()
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(secretTaintFile{Version: 1, Entries: entries}, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, "taint-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

// secretRepoKey is the repository a checkout belongs to: its common git directory, the same for every worktree of it.
func secretRepoKey(dir string) string {
	if common := gitCommonDir(dir); common != "" {
		return realPath(common)
	}
	return ""
}

// recordSecretTaint scans dir's history from tip, not from exclude, for r's values, and records tip when it holds
// one. Entries of the same repository whose commit no local ref reaches any more are pruned on the way.
func recordSecretTaint(dir, tip string, r *integrationOutputRedactor, exclude ...string) {
	if r == nil || tip == "" {
		return
	}
	commit, err := git(dir, "rev-parse", "--verify", "--quiet", tip+"^{commit}")
	if err != nil || commit == "" {
		return
	}
	repo := secretRepoKey(dir)
	if repo == "" {
		return
	}
	paths, err := secretHistoryScan(dir, commit, r, exclude...)
	if err != nil {
		logln("secret grants: the history of", dir, "could not be scanned:", firstLine(err.Error()))
		return
	}
	secretTaintMu.Lock()
	defer secretTaintMu.Unlock()
	entries, err := readSecretTaint()
	if err != nil {
		logln("secret grants: the taint record is unreadable:", err)
		return
	}
	kept := entries[:0]
	changed := false
	for _, entry := range entries {
		if entry.Repo == repo && entry.Commit != commit {
			if refs, err := git(dir, "for-each-ref", "--contains", entry.Commit, "--count=1", "--format=%(refname)"); err != nil || refs == "" {
				changed = true
				continue // reachable from no local ref: it cannot be pushed from here any more
			}
		}
		if entry.Repo == repo && entry.Commit == commit {
			if len(paths) == 0 {
				changed = true
				continue
			}
			paths = nil // already recorded
		}
		kept = append(kept, entry)
	}
	if len(paths) > 0 {
		kept = append(kept, secretTaintEntry{Repo: repo, Commit: commit, Paths: paths, RecordedAt: time.Now().UTC()})
		changed = true
		logln("secret grants: commit", commit, "in", repo, "holds a secret's value; it will not be merged or pushed")
	}
	if changed {
		if err := writeSecretTaint(kept); err != nil {
			logln("secret grants: cannot write the taint record:", err)
		}
	}
}

// taintedPaths is the paths of every recorded commit reachable from tip and from none of exclude, in dir's repository.
// A record that cannot be read refuses everything: it is the only memory of what was there.
func taintedPaths(dir, tip string, exclude ...string) []string {
	secretTaintMu.Lock()
	entries, err := readSecretTaint()
	secretTaintMu.Unlock()
	if err != nil {
		return []string{"(the runner's record of commits holding a secret could not be read: " + firstLine(err.Error()) + ")"}
	}
	if len(entries) == 0 {
		return nil
	}
	repo := secretRepoKey(dir)
	var paths []string
	for _, entry := range entries {
		if entry.Repo != repo || !gitIsAncestor(dir, entry.Commit, tip) {
			continue
		}
		published := false
		for _, ref := range exclude {
			if ref != "" && gitIsAncestor(dir, entry.Commit, ref) {
				published = true
				break
			}
		}
		if !published {
			paths = append(paths, entry.Paths...)
		}
	}
	return paths
}

// gitIsAncestor reports whether commit is reachable from tip. An object that is not there is reachable from nothing.
func gitIsAncestor(dir, commit, tip string) bool {
	_, err := git(dir, "merge-base", "--is-ancestor", commit, tip)
	return err == nil
}

// recordWorktreeTaint scans one session checkout's own history, its tip not its base, for the values held now.
func recordWorktreeTaint(wt *Worktree) {
	r := runnerSecrets().scrubber()
	if r == nil || wt == nil {
		return
	}
	recordSecretTaint(wt.Path, "HEAD", r, wt.baseSha())
}

// taintAllCheckouts scans every session checkout on this runner for r's values: what a grant's removal is about to
// make unrecognisable.
func taintAllCheckouts(r *integrationOutputRedactor) {
	if r == nil {
		return
	}
	entries, err := os.ReadDir(worktreesDir())
	if err != nil {
		return
	}
	for _, entry := range entries {
		dir := filepath.Join(worktreesDir(), entry.Name())
		if !entry.IsDir() || !isGitRepo(dir) {
			continue
		}
		base, _ := git(dir, "rev-parse", "--verify", "--quiet", baseRefName(entry.Name()))
		recordSecretTaint(dir, "HEAD", r, base)
	}
}

// secretBeforeForget runs just before a grant's value is forgotten. A variable for the store's tests.
var secretBeforeForget = taintAllCheckouts
