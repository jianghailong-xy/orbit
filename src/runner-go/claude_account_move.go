package main

import (
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// claudeAccountMoveCapabilityV1 declares that this runner carries a Claude session's conversation into
// the CLAUDE_CONFIG_DIR its claim names (carryClaudeConversation). The control plane moves a Claude
// session to another account only on a runner that declares it: one that does not would rebuild the
// conversation from the event log, shortened behind a compact boundary for a long session.
const claudeAccountMoveCapabilityV1 = "claude-account-move/v1"

// carryClaudeConversation puts a Claude session's conversation where its `--resume` reads it — dst,
// under the config directory base its claim names — when another of this machine's Claude accounts
// holds it: a session the control plane moved off an account whose usage limit stopped it, or that
// somebody moved by hand. Claude Code keeps a conversation as <config>/projects/<cwd slug>/<id>.jsonl
// and a directory of the same name beside it (its sub-agents' transcripts, large tool results); both
// are copied, from the account that last wrote the conversation. The account it came from keeps its
// copy. Reports whether dst now holds the conversation; false leaves the caller to rebuild it.
func carryClaudeConversation(base, execDir, sessionUUID, dst string) bool {
	slots, err := claudeAccountKind.list()
	if err != nil {
		return false
	}
	var src string
	var newest int64
	for _, slot := range slots {
		if filepath.Clean(slot.Dir) == filepath.Clean(base) {
			continue
		}
		path, err := claudeTranscriptPathIn(slot.Dir, execDir, sessionUUID)
		if err != nil || !claudeTranscriptHasConversation(path) {
			continue
		}
		if info, err := os.Stat(path); err == nil && info.ModTime().UnixNano() > newest {
			src, newest = path, info.ModTime().UnixNano()
		}
	}
	if src == "" {
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
	logln("claude conversation for", sessionUUID, "carried from", filepath.Dir(filepath.Dir(filepath.Dir(src))), "to", base)
	return true
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
