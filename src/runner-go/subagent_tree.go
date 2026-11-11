package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// What a stopped SubAgent was writing, read off the working tree rather than off its tool events alone
// (docs/subagent-design.md §5.2). A child writes through Bash as often as through its edit tools — codegen,
// gofmt, sed, fixtures — and those writes leave no path in its event stream. So the runner notes the tree's
// changed and untracked paths, with their mtime and size, when the child starts; when the child is stopped,
// every path that has changed since is held out of the session's finalize commit, except what the parent's own
// edit tools wrote in that window (parentEditLog).

// subagentTreeEntry is one changed or untracked path as it stood: whether it exists, and its mtime and size.
type subagentTreeEntry struct {
	exists bool
	mod    time.Time
	size   int64
}

// subagentTreeSnapshot is the working tree's changed and untracked paths, absolute, at one moment.
type subagentTreeSnapshot struct {
	root    string
	entries map[string]subagentTreeEntry
}

// takeSubagentTreeSnapshot reads the tree dir belongs to. ok is false where dir is no git checkout, or git does
// not answer: then only the child's edit tools say what it wrote.
func takeSubagentTreeSnapshot(dir string) (subagentTreeSnapshot, bool) {
	top, err := exec.Command("git", "-C", dir, "rev-parse", "--show-toplevel").Output()
	if err != nil {
		return subagentTreeSnapshot{}, false
	}
	root := strings.TrimSpace(string(top))
	// Read raw: the first column of a porcelain line may be a space, which a trimmed read would lose.
	out, err := exec.Command("git", "-C", root, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames").Output()
	if err != nil {
		return subagentTreeSnapshot{}, false
	}
	snap := subagentTreeSnapshot{root: root, entries: map[string]subagentTreeEntry{}}
	for _, record := range strings.Split(string(out), "\x00") {
		if len(record) < 4 {
			continue
		}
		path := filepath.Join(root, filepath.FromSlash(record[3:]))
		entry := subagentTreeEntry{}
		if info, err := os.Lstat(path); err == nil {
			entry = subagentTreeEntry{exists: true, mod: info.ModTime(), size: info.Size()}
		}
		snap.entries[path] = entry
	}
	return snap, true
}

// changedSince is every path of after that is new, or differs from how before had it, less those excluded:
// what was written in the window between the two.
func (after subagentTreeSnapshot) changedSince(before subagentTreeSnapshot, exclude map[string]bool) []string {
	var paths []string
	for path, now := range after.entries {
		if exclude[path] {
			continue
		}
		if then, had := before.entries[path]; had && then.exists == now.exists && then.size == now.size && then.mod.Equal(now.mod) {
			continue
		}
		paths = append(paths, path)
	}
	sort.Strings(paths)
	return paths
}

// parentEditLog is when the parent's own edit tools named each file, by absolute path: the writes a stopped
// SubAgent's hold must leave to the parent. The parent's own nested Agent calls count as the parent's; a
// SubAgent's events (subagentRunId) never do.
type parentEditLog struct {
	mu    sync.Mutex
	dir   string
	edits map[string]time.Time
}

// note reads one event the parent's stream carries.
func (l *parentEditLog) note(eventType string, payload map[string]interface{}) {
	if l == nil || eventType != evToolUse {
		return
	}
	if id, _ := payload["subagentRunId"].(string); id != "" {
		return
	}
	field, ok := subagentEditTools[asString(payload["name"])]
	if !ok {
		return
	}
	input, _ := payload["input"].(map[string]interface{})
	path := asString(input[field])
	if path == "" {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if !filepath.IsAbs(path) {
		path = filepath.Join(l.dir, path)
	}
	if l.edits == nil {
		l.edits = map[string]time.Time{}
	}
	l.edits[filepath.Clean(path)] = time.Now()
}

// since is every path the parent's edit tools named at or after from.
func (l *parentEditLog) since(from time.Time) map[string]bool {
	paths := map[string]bool{}
	if l == nil {
		return paths
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	for path, at := range l.edits {
		if !at.Before(from) {
			paths[path] = true
		}
	}
	return paths
}

// subagentHeldNote is what a stopped run's result says of the files it leaves uncommitted.
func subagentHeldNote(runID, root string, paths []string) string {
	if len(paths) == 0 {
		return ""
	}
	shown := make([]string, 0, len(paths))
	for _, p := range paths {
		if rel, err := filepath.Rel(root, p); err == nil && root != "" && !strings.HasPrefix(rel, "..") {
			p = rel
		}
		shown = append(shown, filepath.ToSlash(p))
	}
	sort.Strings(shown)
	return "Left uncommitted because SubAgent " + runID + " was stopped while they changed: " + strings.Join(shown, ", ")
}
