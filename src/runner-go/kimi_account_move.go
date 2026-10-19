package main

// A Kimi Code conversation lives in the KIMI_CODE_HOME of the account it ran on, as
// sessions/<bucket>/<id>/: state.json (the session's record — its cwd, updatedAt, its agents), each
// agent's conversation in agents/<agent>/wire.jsonl, and its logs. <bucket> is Kimi's key for the
// session's working directory (encodeWorkDirKey: "wd_" + a slug of the directory's name + "_" + 12 hex
// of its sha-256), the same in every home. A session moved to another of this machine's Kimi accounts
// resumes there only if that directory is there too, and carryKimiConversation puts it there.
//
// How Kimi 2.1.x finds a session it resumes by id (measured on kimi 2.1.1 in a throwaway home, and read
// in its source): under its own KIMI_CODE_HOME — for a session the runner runs, the private overlay
// whose sessions/ is the account's (kimi_home.go) — at sessions/*/<id>/state.json. The directory and
// each agent's are recomputed from that home (sessionDirOf, buildAgentScope), and state.json's
// agents.*.homedir is rewritten to match on the next write. session_index.jsonl, {sessionId,
// sessionDir, workDir} a line, is only a hint for which bucket to read first, and only when sessionDir
// lies under that same home's sessions/: an absolute path into another home, or into an overlay since
// removed, is passed over and the buckets are listed. workspaces.json is the workspace catalog Kimi's
// own pickers list, rebuilt from the index when it is missing and merged with it when it is not.

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// kimiAccountMoveCapabilityV1 declares that this runner carries a Kimi session's conversation into the
// KIMI_CODE_HOME its claim names (carryKimiConversation). The control plane moves a Kimi session that
// has said something to another account only on a runner that declares it: one that does not would
// resume it in a home where its conversation is not.
const kimiAccountMoveCapabilityV1 = "kimi-account-move/v1"

// kimiSessionIndexEntry is one line of a home's session_index.jsonl, as Kimi writes it.
type kimiSessionIndexEntry struct {
	SessionID  string `json:"sessionId"`
	SessionDir string `json:"sessionDir"`
	WorkDir    string `json:"workDir"`
}

// carryKimiConversation puts Kimi session id's conversation in home — the real KIMI_CODE_HOME the
// session is about to resume in — when another of this machine's Kimi accounts holds a newer one: a
// session the control plane moved off an account whose usage limit stopped it, or that somebody moved
// by hand. The whole of sessions/<bucket>/<id> is copied from the account whose copy moved last
// (kimiConversationMovedAt), its sub-agents and logs with it, and the account it came from keeps its
// copy. alsoFrom names homes to look in besides the accounts — the one the session's record says it
// ran in, which a KIMI_CODE_HOME typed into a workspace's env makes no account of.
//
// A copy already in home is replaced as well when another account's moved after it, so a session moved
// back to an account it ran on before resumes the turns it had on the other account since, not the
// copy it left there. One that ends where the newest does is the same conversation, and stays.
//
// The copy is made beside the account's sessions and put in place in one rename, the copy it replaces
// set aside first and put back if that rename fails: a carry that fails leaves home as it was. Then the
// home's session_index.jsonl gains the session's line (sessionDir in this home, as Kimi's own legacy
// migration writes it), its workspaces.json the session's workspace where it keeps one without it, and
// Kimi's dirty journal a mark, so its read model re-reads the session's summary. None of those is what
// the resume reads, so each is best-effort.
//
// Reports whether it carried the conversation; false with no error is nothing to carry.
func carryKimiConversation(home, id string, alsoFrom ...string) (bool, error) {
	home = filepath.Clean(home)
	if !kimiSessionIDUsable(id) {
		return false, nil
	}
	slots, err := kimiAccountKind.list()
	if err != nil {
		return false, err
	}
	sources := make([]string, 0, len(slots)+len(alsoFrom))
	names := map[string]string{}
	for _, slot := range slots {
		sources = append(sources, filepath.Clean(slot.Dir))
		names[filepath.Clean(slot.Dir)] = slot.ID
	}
	for _, dir := range alsoFrom {
		if dir != "" {
			sources = append(sources, filepath.Clean(dir))
		}
	}
	label := func(dir string) string {
		if name, ok := names[dir]; ok {
			return name + " (" + dir + ")"
		}
		return dir
	}

	here := kimiSessionDirIn(home, id)
	var hereAt time.Time
	if here != "" {
		hereAt = kimiConversationMovedAt(here)
	}
	var src, from string
	var srcAt time.Time
	seen := map[string]bool{home: true}
	for _, dir := range sources {
		if seen[dir] {
			continue
		}
		seen[dir] = true
		path := kimiSessionDirIn(dir, id)
		if path == "" {
			continue
		}
		// A copy whose date cannot be read cannot be shown to be the newest.
		if at := kimiConversationMovedAt(path); !at.IsZero() && (src == "" || at.After(srcAt)) {
			src, from, srcAt = path, label(dir), at
		}
	}
	if src == "" || here != "" && !srcAt.After(hereAt) {
		return false, nil
	}
	bucket := filepath.Base(filepath.Dir(src))
	if err := copyKimiSessionDir(src, home, bucket, id); err != nil {
		return false, fmt.Errorf("copy from account %s: %w", from, err)
	}
	dst := filepath.Join(home, "sessions", bucket, id)
	if workDir := kimiSessionWorkDir(dst); workDir == "" {
		logln("kimi conversation for", id, "carried without an index line: its state.json names no working directory")
	} else {
		if err := ensureKimiSessionIndexEntry(home, kimiSessionIndexEntry{SessionID: id, SessionDir: dst, WorkDir: workDir}); err != nil {
			logln("kimi conversation for", id, "carried without its index line:", err)
		}
		if err := ensureKimiWorkspace(home, bucket, workDir); err != nil {
			logln("kimi conversation for", id, "carried without its workspace in workspaces.json:", err)
		}
	}
	if err := markKimiSessionDirty(home, id); err != nil {
		logln("kimi conversation for", id, "carried without a dirty mark:", err)
	}
	if here != "" {
		logln("kimi conversation for", id, "carried from account", from, "to", label(home),
			"over the older copy there (it ends at", hereAt.UTC().Format(time.RFC3339Nano)+", the carried one at", srcAt.UTC().Format(time.RFC3339Nano)+")")
	} else {
		logln("kimi conversation for", id, "carried from account", from, "to", label(home))
	}
	return true, nil
}

// kimiSessionIDUsable keeps an id that is not one name in a directory — empty, a dot path or one with
// a separator — out of every path built from it.
func kimiSessionIDUsable(id string) bool {
	return id != "" && id != "." && id != ".." && !strings.ContainsAny(id, `/\`)
}

// kimiSessionDirIn is session id's directory in home — sessions/<bucket>/<id> holding its state.json,
// where Kimi reads it — or "" when home has none. Dot entries of sessions/ are Kimi's own journals
// (.index-dirty, .index-cache), not workspaces.
func kimiSessionDirIn(home, id string) string {
	if !kimiSessionIDUsable(id) {
		return ""
	}
	buckets, err := os.ReadDir(filepath.Join(home, "sessions"))
	if err != nil {
		return ""
	}
	for _, bucket := range buckets {
		if !bucket.IsDir() || strings.HasPrefix(bucket.Name(), ".") {
			continue
		}
		dir := filepath.Join(home, "sessions", bucket.Name(), id)
		if kimiSessionStatePath(dir) != "" {
			return dir
		}
	}
	return ""
}

// kimiSessionStatePath is the session record in dir: state.json, or session-meta/state.json where an
// older Kimi kept it — the two places Kimi reads it from — or "" when dir has neither.
func kimiSessionStatePath(dir string) string {
	for _, path := range []string{filepath.Join(dir, "state.json"), filepath.Join(dir, "session-meta", "state.json")} {
		if info, err := os.Stat(path); err == nil && info.Mode().IsRegular() {
			return path
		}
	}
	return ""
}

// kimiSessionState is what is read of a session's state.json. Kimi writes updatedAt as epoch
// milliseconds, and reads a date string too.
type kimiSessionState struct {
	CWD       string          `json:"cwd"`
	WorkDir   string          `json:"workDir"`
	UpdatedAt json.RawMessage `json:"updatedAt"`
	Custom    struct {
		CWD string `json:"cwd"`
	} `json:"custom"`
}

func readKimiSessionState(dir string) (kimiSessionState, bool) {
	var state kimiSessionState
	path := kimiSessionStatePath(dir)
	if path == "" {
		return state, false
	}
	data, err := os.ReadFile(path)
	if err != nil || json.Unmarshal(data, &state) != nil {
		return state, false
	}
	return state, true
}

// kimiSessionWorkDir is the working directory a session's record names, read the way Kimi recovers it
// (recoverCwd): cwd, else the older workDir, else custom.cwd.
func kimiSessionWorkDir(dir string) string {
	state, ok := readKimiSessionState(dir)
	if !ok {
		return ""
	}
	for _, cwd := range []string{state.CWD, state.WorkDir, state.Custom.CWD} {
		if cwd != "" {
			return cwd
		}
	}
	return ""
}

// kimiConversationMovedAt is when the conversation in a Kimi session directory last moved: the later of
// its record's updatedAt and the latest stamp among the last records of its main agent's wire — the
// wire too, because a turn the engine was stopped in the middle of has written its records there
// without the record catching up. Both are read from the copy, never from when its files were written:
// carrying a copy rewrites them without adding a turn to it. Zero when neither can be read.
func kimiConversationMovedAt(dir string) time.Time {
	var latest time.Time
	if state, ok := readKimiSessionState(dir); ok {
		latest = kimiStamp(state.UpdatedAt)
	}
	if at := kimiWireMovedAt(filepath.Join(dir, "agents", "main", "wire.jsonl")); at.After(latest) {
		latest = at
	}
	return latest
}

// kimiWireMovedAt is the latest stamp among a wire's last records: `time`, which Kimi puts on the
// records of a turn, or the metadata line's `created_at`, both epoch milliseconds. The stretch is read
// further back only while it holds none, up to transcriptConversationScanCap. Zero when nothing is
// stamped or the file cannot be read.
func kimiWireMovedAt(path string) time.Time {
	f, err := os.Open(path)
	if err != nil {
		return time.Time{}
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return time.Time{}
	}
	for window := int64(transcriptReadBuffer); ; window *= 4 {
		start := max(0, info.Size()-window)
		tail := make([]byte, info.Size()-start)
		if _, err := f.ReadAt(tail, start); err != nil {
			return time.Time{}
		}
		lines := bytes.Split(tail, []byte{'\n'})
		if start > 0 {
			lines = lines[1:] // the stretch begins inside a record
		}
		var latest time.Time
		for _, line := range lines {
			var rec struct {
				Time      json.RawMessage `json:"time"`
				CreatedAt json.RawMessage `json:"created_at"`
			}
			if json.Unmarshal(line, &rec) != nil {
				continue
			}
			for _, stamp := range []json.RawMessage{rec.Time, rec.CreatedAt} {
				if at := kimiStamp(stamp); at.After(latest) {
					latest = at
				}
			}
		}
		if !latest.IsZero() || start == 0 || window >= transcriptConversationScanCap {
			return latest
		}
	}
}

// kimiStamp reads one of Kimi's stamps: epoch milliseconds, or a date string. Zero for anything else.
func kimiStamp(raw json.RawMessage) time.Time {
	if len(raw) == 0 {
		return time.Time{}
	}
	var ms float64
	if json.Unmarshal(raw, &ms) == nil {
		if ms <= 0 {
			return time.Time{}
		}
		return time.UnixMilli(int64(ms))
	}
	var text string
	if json.Unmarshal(raw, &text) == nil {
		if at, err := time.Parse(time.RFC3339Nano, text); err == nil {
			return at
		}
	}
	return time.Time{}
}

// kimiCarryCopyFile and kimiCarryRename are the two steps of a carry that touch the disk, a test's to
// fail.
var (
	kimiCarryCopyFile = copyKimiSessionFile
	kimiCarryRename   = os.Rename
)

// copyKimiSessionDir copies session directory src into home's sessions/<bucket>/<id>. The copy is made
// in a staging directory of the session's own in home — never under sessions/, whose every directory
// Kimi lists as a workspace and every entry of those as a session — and put in place in one rename. A
// copy already in place is set aside into the staging directory first and put back if that rename
// fails, so whatever fails, home's sessions hold either the copy they held or the whole new one. The
// staging directory goes when the carry ends, and one a carry of the same session left behind (killed
// mid-copy) goes when the next one begins.
func copyKimiSessionDir(src, home, bucket, id string) error {
	stage := filepath.Join(home, ".orbit-kimi-carry-"+id)
	if err := os.RemoveAll(stage); err != nil {
		return err
	}
	if err := os.Mkdir(stage, machineHomePerm); err != nil {
		return err
	}
	defer os.RemoveAll(stage)
	staged := filepath.Join(stage, id)
	if err := copyKimiSessionTree(src, staged); err != nil {
		return err
	}
	bucketDir := filepath.Join(home, "sessions", bucket)
	// 0700, as Kimi makes its session directories.
	if err := os.MkdirAll(bucketDir, machineHomePerm); err != nil {
		return err
	}
	dst := filepath.Join(bucketDir, id)
	previous := filepath.Join(stage, "previous")
	hadPrevious := false
	if _, err := os.Lstat(dst); err == nil {
		if err := kimiCarryRename(dst, previous); err != nil {
			return err
		}
		hadPrevious = true
	} else if !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	if err := kimiCarryRename(staged, dst); err != nil {
		if hadPrevious {
			if back := os.Rename(previous, dst); back != nil {
				return fmt.Errorf("%w (and the copy that was there could not be put back: %v)", err, back)
			}
		}
		return err
	}
	return nil
}

// copyKimiSessionTree copies the directories and regular files under src into dst, keeping their
// relative paths and modes. Links are left behind: a copy must not point into another account's home.
func copyKimiSessionTree(src, dst string) error {
	return filepath.WalkDir(src, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		info, err := entry.Info()
		if err != nil {
			return err
		}
		switch {
		case entry.IsDir():
			if err := os.Mkdir(target, info.Mode().Perm()); err != nil {
				return err
			}
			// Mkdir applies the umask; the copy keeps the mode Kimi gave the original.
			return os.Chmod(target, info.Mode().Perm())
		case entry.Type().IsRegular():
			return kimiCarryCopyFile(path, target, info.Mode().Perm())
		}
		return nil
	})
}

func copyKimiSessionFile(src, dst string, perm fs.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, perm)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		_ = out.Close()
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	return os.Chmod(dst, perm)
}

// ensureKimiSessionIndexEntry appends entry to home's session_index.jsonl unless a line there already
// says the same — Kimi's own ensureSessionIndexEntry, from the migration that copies sessions into
// another home, made exact about the directory: a line for this session that names another one (the
// overlay's, written by a session that ran here before) is a hint Kimi passes over, so this one is
// added after it. The file is made, private, when home has none.
func ensureKimiSessionIndexEntry(home string, entry kimiSessionIndexEntry) error {
	path := filepath.Join(home, "session_index.jsonl")
	existing, err := os.ReadFile(path)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	for _, line := range bytes.Split(existing, []byte{'\n'}) {
		var have kimiSessionIndexEntry
		if json.Unmarshal(bytes.TrimSpace(line), &have) == nil && have == entry {
			return nil
		}
	}
	line, err := json.Marshal(entry)
	if err != nil {
		return err
	}
	// A last line some writer left unfinished must not swallow this one.
	if len(existing) > 0 && existing[len(existing)-1] != '\n' {
		line = append([]byte{'\n'}, line...)
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o600)
	if err != nil {
		return err
	}
	if _, err := f.Write(append(line, '\n')); err != nil {
		_ = f.Close()
		return err
	}
	return f.Close()
}

// ensureKimiWorkspace lists workspace bucket, rooted at workDir, in home's workspaces.json when home
// keeps one that does not — or that lists it as deleted — the way Kimi itself does when a workspace is
// opened (createOrTouch). A home with no workspaces.json is left without one: Kimi builds it from
// session_index.jsonl the first time it reads it. A file this cannot read is left as it is.
func ensureKimiWorkspace(home, bucket, workDir string) error {
	path := filepath.Join(home, "workspaces.json")
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	var catalog map[string]json.RawMessage
	if err := json.Unmarshal(data, &catalog); err != nil || catalog == nil {
		return fmt.Errorf("%s is not a workspace catalog", path)
	}
	workspaces := map[string]json.RawMessage{}
	if raw, ok := catalog["workspaces"]; ok && json.Unmarshal(raw, &workspaces) != nil {
		return fmt.Errorf("%s is not a workspace catalog", path)
	}
	var deleted []string
	if raw, ok := catalog["deleted_workspace_ids"]; ok {
		_ = json.Unmarshal(raw, &deleted)
	}
	kept := deleted[:0:0]
	for _, id := range deleted {
		if id != bucket {
			kept = append(kept, id)
		}
	}
	_, listed := workspaces[bucket]
	if listed && len(kept) == len(deleted) {
		return nil
	}
	if !listed {
		now := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
		entry, err := json.Marshal(map[string]string{
			"root": workDir, "name": filepath.Base(workDir), "created_at": now, "last_opened_at": now,
		})
		if err != nil {
			return err
		}
		workspaces[bucket] = entry
	}
	if catalog["workspaces"], err = json.Marshal(workspaces); err != nil {
		return err
	}
	if catalog["deleted_workspace_ids"], err = json.Marshal(kept); err != nil {
		return err
	}
	out, err := json.Marshal(catalog)
	if err != nil {
		return err
	}
	return writeFileAtomically(path, out, 0o600)
}

// markKimiSessionDirty writes the mark Kimi's own writers leave when a session's summary changes
// (markSessionDirty: an empty sessions/.index-dirty/<id>.<epoch ms>), so a read model Kimi keeps of this
// home re-reads the carried session's summary instead of the one an older copy left in it.
func markKimiSessionDirty(home, id string) error {
	dir := filepath.Join(home, "sessions", ".index-dirty")
	if err := os.MkdirAll(dir, machineHomePerm); err != nil {
		return err
	}
	mark := filepath.Join(dir, id+"."+strconv.FormatInt(time.Now().UnixMilli(), 10))
	f, err := os.OpenFile(mark, os.O_WRONLY|os.O_CREATE, 0o600)
	if err != nil {
		return err
	}
	return f.Close()
}
