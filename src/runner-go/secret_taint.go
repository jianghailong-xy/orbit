package main

import (
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// A value is forgotten when its grant ends, but a commit that holds it does not go away with it. So while a value is
// still known — at the end of each turn of a session on a runner that holds any grant, and just before a grant is
// removed — every session checkout's own history (its tip, not its base) is scanned (secretHistoryScan), and a commit
// whose history holds a value is recorded here: the repository, the commit id and the paths, never the value or any
// hash of it. Every merge and push guard refuses a tip from which a recorded commit is reachable and the target is not
// (secretPushRefusal), with no grant held at all.

// secretTaintEntry is one recorded commit, and the objects in its history that hold a value.
//
// Objects are recorded by their git object id so that a rewritten copy of the commit — rebased, amended, squashed,
// cherry-picked, Orbit's own integration rebase and merge-recovery replay included — is still recognised: it carries
// the same blob. A git object id is a hash of the object's content, but it is no new exposure of the value: git itself
// already stores that id, beside the object it names, in this same repository on this same disk, so this 0600 file
// says nothing anyone who can read the repository cannot read there. It is never a hash of the value alone.
type secretTaintEntry struct {
	Repo       string              `json:"repo"` // the repository's common git directory
	Commit     string              `json:"commit"`
	Paths      []string            `json:"paths"`
	Objects    []secretTaintObject `json:"objects,omitempty"`
	RecordedAt time.Time           `json:"recordedAt"`
}

// secretTaintObject is one object holding a value: its git object id and the path it was found at.
type secretTaintObject struct {
	ID   string `json:"id"`
	Path string `json:"path,omitempty"`
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
	// On disk before it replaces the old record: a rename that a crash leaves pointing at unflushed bytes would leave
	// an empty record, and an empty record has forgotten what it was for.
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		return err
	}
	if d, err := os.Open(dir); err == nil {
		_ = d.Sync()
		d.Close()
	}
	return nil
}

// secretRepoKey is the repository a checkout belongs to: its common git directory, the same for every worktree of it.
func secretRepoKey(dir string) string {
	if common := gitCommonDir(dir); common != "" {
		return realPath(common)
	}
	return ""
}

// recordSecretTaint scans dir's history from tip, not from exclude, for r's values, and records tip and the objects
// holding one. An entry of the same repository none of whose objects, its commit included, is still in the
// repository is pruned on the way: nothing of it is left to publish. (An entry is not pruned because its commit is no
// longer on a branch: that is what a rewrite does, and the rewritten copy still carries the objects.)
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
	hits, err := secretHistoryObjects(dir, commit, r, exclude...)
	paths := objectHitPaths(hits)
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
	merged := false
	for _, entry := range entries {
		// An entry of objects alone (recordTaintObjects) stays: its blob may be gone from the object store and still
		// be made again by the next `git add` of a file that holds it.
		if entry.Repo == repo && entry.Commit != "" && entry.Commit != commit && !taintEntryPresent(dir, entry) {
			changed = true
			continue
		}
		if entry.Repo == repo && entry.Commit == commit {
			// Only ever added to. A commit never changes, so a scan that finds nothing in it now means only that the
			// value recorded earlier is no longer held — never that the commit stopped holding it. What this scan
			// found (another grant's value, say) joins what was recorded before.
			merged = true
			if added := mergeTaintHits(&entry, paths, hits); added {
				changed = true
			}
		}
		kept = append(kept, entry)
	}
	if !merged && len(paths) > 0 {
		objects := make([]secretTaintObject, 0, len(hits))
		for _, hit := range hits {
			objects = append(objects, secretTaintObject{ID: hit.id, Path: hit.path})
		}
		kept = append(kept, secretTaintEntry{Repo: repo, Commit: commit, Paths: paths, Objects: objects, RecordedAt: time.Now().UTC()})
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
	// Any recorded object among what tip would publish: a rewritten copy of a recorded commit carries them.
	objects := map[string]string{}
	for _, entry := range entries {
		if entry.Repo != repo {
			continue
		}
		for _, object := range entry.Objects {
			objects[object.ID] = object.Path
		}
	}
	if len(objects) > 0 {
		ids, names, err := listPublishedObjects(dir, tip, exclude...)
		if err != nil {
			return []string{"(what this would publish could not be listed: " + firstLine(err.Error()) + ")"}
		}
		for _, id := range ids {
			if path, tainted := objects[id]; tainted {
				if names[id] != "" {
					path = names[id]
				}
				if path == "" {
					path = "object " + id
				}
				paths = append(paths, path)
			}
		}
	}
	for _, entry := range entries {
		if entry.Repo != repo || entry.Commit == "" || !gitIsAncestor(dir, entry.Commit, tip) {
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
	// Each path once, whether the object or the commit named it.
	seen := map[string]bool{}
	unique := paths[:0]
	for _, path := range paths {
		if !seen[path] {
			seen[path] = true
			unique = append(unique, path)
		}
	}
	return unique
}

// taintEntryPresent reports whether anything an entry recorded is still an object of dir's repository.
// Only git's own answer that an object is missing (`cat-file -e` exits 1) counts as gone. Any other failure — git not
// starting, the repository unreadable — keeps the entry: pruning is the one thing here that must never guess.
func taintEntryPresent(dir string, entry secretTaintEntry) bool {
	ids := make([]string, 0, len(entry.Objects)+1)
	if entry.Commit != "" {
		ids = append(ids, entry.Commit)
	}
	for _, object := range entry.Objects {
		ids = append(ids, object.ID)
	}
	if len(ids) == 0 {
		return true
	}
	for _, id := range ids {
		_, err := git(dir, "cat-file", "-e", id)
		if err == nil || !taintObjectMissing(err) {
			return true
		}
	}
	return false
}

// taintObjectMissing reports whether err is `git cat-file -e` saying the object does not exist (exit status 1).
func taintObjectMissing(err error) bool {
	var exit *exec.ExitError
	return errors.As(err, &exit) && exit.ExitCode() == 1
}

// taintAppliesTo reports whether any recorded entry is of dir's repository, or whether the record cannot be read.
func taintAppliesTo(dir string) bool {
	secretTaintMu.Lock()
	entries, err := readSecretTaint()
	secretTaintMu.Unlock()
	if err != nil {
		return true
	}
	repo := secretRepoKey(dir)
	for _, entry := range entries {
		if entry.Repo == repo {
			return true
		}
	}
	return false
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
		// What is not committed yet: a file held back from a commit stays in the working tree, and the next
		// `git add -A` after the value is forgotten would stage it.
		recordTaintObjects(dir, uncommittedObjectsHolding(dir, r))
	}
}

// uncommittedObjectsHolding is every file of dir's index and working tree that a `git add -A` could stage (tracked,
// and untracked but not ignored) and whose content holds one of r's values, with the blob id `git hash-object` gives
// its content: the id a `git add` of it makes. Staged blobs that differ from the file are taken too.
func uncommittedObjectsHolding(dir string, r *integrationOutputRedactor) []secretTaintObject {
	if r == nil {
		return nil
	}
	var hits []secretTaintObject
	hits = append(hits, stagedFilesHoldingSecrets(dir, nil, r, nil)...)
	out, err := git(dir, "ls-files", "-z", "--cached", "--others", "--exclude-standard")
	if err != nil {
		return hits
	}
	for _, name := range strings.Split(out, "\x00") {
		if name == "" {
			continue
		}
		path := filepath.Join(dir, name)
		info, err := os.Lstat(path)
		if err != nil || !info.Mode().IsRegular() || info.Size() > secretScanFileMax {
			continue
		}
		file, err := os.Open(path)
		if err != nil {
			continue
		}
		holds, _ := readerHoldsSecret(file, r)
		file.Close()
		if !holds {
			continue
		}
		if id, err := git(dir, "hash-object", "--", name); err == nil && id != "" {
			hits = append(hits, secretTaintObject{ID: id, Path: name})
		}
	}
	return hits
}

// secretScanFileMax bounds the working-tree files read at a removal; a bigger one is no file a value is pasted into.
const secretScanFileMax = 64 << 20

// recordTaintObjects records objects, ids and paths only, as dir's repository's entry of objects alone.
func recordTaintObjects(dir string, objects []secretTaintObject) {
	if len(objects) == 0 {
		return
	}
	repo := secretRepoKey(dir)
	if repo == "" {
		return
	}
	secretTaintMu.Lock()
	defer secretTaintMu.Unlock()
	entries, err := readSecretTaint()
	if err != nil {
		logln("secret grants: the taint record is unreadable:", err)
		return
	}
	at := -1
	for i, entry := range entries {
		if entry.Repo == repo && entry.Commit == "" {
			at = i
		}
	}
	if at < 0 {
		entries = append(entries, secretTaintEntry{Repo: repo, RecordedAt: time.Now().UTC()})
		at = len(entries) - 1
	}
	known := map[string]bool{}
	for _, object := range entries[at].Objects {
		known[object.ID] = true
	}
	changed := false
	for _, object := range objects {
		if object.ID == "" || known[object.ID] {
			continue
		}
		known[object.ID] = true
		entries[at].Objects = append(entries[at].Objects, object)
		entries[at].Paths = appendUnique(entries[at].Paths, object.Path)
		changed = true
	}
	if changed {
		if err := writeSecretTaint(entries); err != nil {
			logln("secret grants: cannot write the taint record:", err)
		}
	}
}

// taintObjectIDs is every recorded object id of dir's repository, with its path.
func taintObjectIDs(dir string) map[string]string {
	return taintObjects(secretRepoKey(dir))
}

// taintObjects is every recorded object id of repo, or of every repository when repo is "". An unreadable record is
// none: a caller that must fail closed asks taintObjectsChecked.
func taintObjects(repo string) map[string]string {
	ids, _ := taintObjectsChecked(repo)
	return ids
}

// taintObjectsChecked is taintObjects, and whether the record could be read at all.
func taintObjectsChecked(repo string) (map[string]string, bool) {
	secretTaintMu.Lock()
	entries, err := readSecretTaint()
	secretTaintMu.Unlock()
	if err != nil {
		return nil, false
	}
	ids := map[string]string{}
	for _, entry := range entries {
		if repo != "" && entry.Repo != repo {
			continue
		}
		for _, object := range entry.Objects {
			ids[object.ID] = object.Path
		}
	}
	return ids, true
}

// secretBeforeForget runs just before a grant's value is forgotten. A variable for the store's tests.
var secretBeforeForget = taintAllCheckouts

// mergeTaintHits adds to entry the paths and objects of hits it does not already hold, and reports whether it added any.
func mergeTaintHits(entry *secretTaintEntry, paths []string, hits []objectHit) bool {
	added := false
	havePath := map[string]bool{}
	for _, path := range entry.Paths {
		havePath[path] = true
	}
	for _, path := range paths {
		if !havePath[path] {
			entry.Paths = append(entry.Paths, path)
			havePath[path] = true
			added = true
		}
	}
	haveObject := map[string]bool{}
	for _, object := range entry.Objects {
		haveObject[object.ID] = true
	}
	for _, hit := range hits {
		if !haveObject[hit.id] {
			entry.Objects = append(entry.Objects, secretTaintObject{ID: hit.id, Path: hit.path})
			haveObject[hit.id] = true
			added = true
		}
	}
	return added
}
