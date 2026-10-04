package main

import (
	"bytes"
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// claudeAccountMoveCapabilityV1 declares that this runner carries a Claude session's conversation into
// the CLAUDE_CONFIG_DIR its claim names (carryClaudeConversation). The control plane moves a Claude
// session to another account only on a runner that declares it: one that does not would rebuild the
// conversation from the event log, shortened behind a compact boundary for a long session.
const claudeAccountMoveCapabilityV1 = "claude-account-move/v1"

// carryClaudeConversation puts a Claude session's conversation where its `--resume` reads it — dst,
// under the config directory base its claim names — when another of this machine's Claude accounts
// holds a newer one: a session the control plane moved off an account whose usage limit stopped it, or
// that somebody moved by hand. Claude Code keeps a conversation as <config>/projects/<cwd slug>/<id>.jsonl
// and a directory of the same name beside it (its sub-agents' transcripts, large tool results); both
// are copied, from the account whose copy moved last. The account it came from keeps its copy.
//
// A copy already at dst is replaced as well when another account's moved after it. A session moved
// back to an account it ran on before finds the copy it left there, without the turns it had on the
// other account since, and resuming that copy drops them without the session ever knowing it
// (2026-10-03). Which copy moved last is read from the copies (claudeConversationMovedAt), not from
// when their files were written: carrying one rewrites dst without adding a turn to it. A copy here that
// ends where the newest one does is the same conversation, and stays.
// Reports whether it carried a conversation to dst; false leaves the caller to resume the one dst
// holds, or to rebuild one when it holds none.
func carryClaudeConversation(base, execDir, sessionUUID, dst string) bool {
	slots, err := claudeAccountKind.list()
	if err != nil {
		return false
	}
	here := claudeTranscriptHasConversation(dst)
	var hereAt time.Time
	if here {
		if hereAt = claudeConversationMovedAt(dst); hereAt.IsZero() {
			return false // a copy here that cannot be read for its date stays, as it did before this check
		}
	}
	to := base
	var src, from string
	var srcAt time.Time
	for _, slot := range slots {
		if filepath.Clean(slot.Dir) == filepath.Clean(base) {
			to = slot.ID + " (" + base + ")"
			continue
		}
		path, err := claudeTranscriptPathIn(slot.Dir, execDir, sessionUUID)
		if err != nil || !claudeTranscriptHasConversation(path) {
			continue
		}
		if at := claudeConversationMovedAt(path); src == "" || at.After(srcAt) {
			src, from, srcAt = path, slot.ID+" ("+slot.Dir+")", at
		}
	}
	if src == "" || here && !srcAt.After(hereAt) {
		return false
	}
	if err := copyClaudeConversationFile(src, dst); err != nil {
		logln("claude conversation for", sessionUUID, "not carried to", base+":", err)
		return false
	}
	// The directory beside it is best-effort: the conversation resumes without it, and a tool result
	// it cannot find is read as gone rather than as a failed resume.
	if err := copyClaudeConversationDir(strings.TrimSuffix(src, ".jsonl"), strings.TrimSuffix(dst, ".jsonl")); err != nil {
		logln("claude conversation for", sessionUUID, "carried without its side files:", err)
	}
	if here {
		logln("claude conversation for", sessionUUID, "carried from account", from, "to account", to,
			"over the older copy there (it ends at", hereAt.UTC().Format(time.RFC3339Nano)+", the carried one at", srcAt.UTC().Format(time.RFC3339Nano)+")")
	} else {
		logln("claude conversation for", sessionUUID, "carried from account", from, "to account", to)
	}
	return true
}

// claudeConversationMovedAt is when the conversation in a transcript last moved: the latest timestamp
// among the records at the end of the file. Claude Code stamps the records of a conversation (user,
// assistant, attachment, system) and not its bookkeeping (last-prompt, mode), and only nearly in order —
// an attachment can be stamped a few milliseconds after the message written behind it — so the latest
// stamp in the file's last stretch is taken, and the stretch read further back only while it holds
// none. Where nothing within transcriptConversationScanCap of the end is stamped, the file's
// modification time stands in. Zero when the file cannot be read.
func claudeConversationMovedAt(path string) time.Time {
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
				Timestamp time.Time `json:"timestamp"`
			}
			if json.Unmarshal(line, &rec) == nil && rec.Timestamp.After(latest) {
				latest = rec.Timestamp
			}
		}
		if !latest.IsZero() {
			return latest
		}
		if start == 0 || window >= transcriptConversationScanCap {
			return info.ModTime()
		}
	}
}

// copyClaudeConversationFile writes src's bytes over dst in one rename, so a claude never reads half a
// conversation; dst's directory is made as Claude Code makes it.
func copyClaudeConversationFile(src, dst string) error {
	info, err := os.Stat(src)
	if err != nil {
		return err
	}
	data, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	return writeFileAtomically(dst, data, info.Mode().Perm())
}

// copyClaudeConversationDir copies the regular files under src into dst, keeping their relative paths.
// Links are left behind: a copy must not point into another account's directory. No src is nothing
// to copy.
func copyClaudeConversationDir(src, dst string) error {
	if _, err := os.Stat(src); err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	return filepath.WalkDir(src, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return os.MkdirAll(filepath.Join(dst, rel), 0o755)
		}
		if !entry.Type().IsRegular() {
			return nil
		}
		return copyClaudeConversationFile(path, filepath.Join(dst, rel))
	})
}
