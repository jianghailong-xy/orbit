package main

import "strings"

// The note a session's next message carries after its conversation was compacted or resumed
// (docs/orbit-agent-contract.md §0 rule 10, §2.6).
//
// Both engines have Orbit's rule in front of them when it applies: Claude Code keeps the primer in its appended
// system prompt and attaches Orbit's MCP instructions again after a summary, and Codex is given its application
// context again after a compaction (codexNotificationCompacted). On 2026-11-14 the agent-contract eval measured what
// that left (E8-compaction-recovery): after a compaction, or a new process resuming the conversation, "Continue." was
// answered from the summary — the task's id and status rebuilt from it with no tool read on Claude Code 2.1.325
// (claude-sonnet-5-5), and a task other than the session's own re-read by an id the summary carried on Codex 0.169.0
// (gpt-6.1-sol). The moment the rule applies is the next message, so that message carries it, as a Claude message
// already carries the output of a `!` shell or the paths of uploaded files: in what the engine reads, not in the
// `user` event the clients show.

// orbitContextResetNote is the note for a session that runs a task; orbitContextResetNoteFree for one that runs
// none, where task_get with no id has nothing to read. Measured on the first: told only to read "what you are working
// on", the agent re-read the follow-up it had filed and not its own task, so the note named the task; told to read
// "this session's task again with task_get (no id)", claude-sonnet-5-5 still re-read the follow-up by its id in two
// runs of three (2026-11-16), so the note says the call to make and that the session's task is not one it filed.
const (
	orbitContextResetNote = "[Orbit: this conversation was compacted or resumed since your last turn. Before you act on " +
		"this message, call task_get with no arguments: it reads the task this session was started for, which is not a " +
		"task you filed. Then read again any other record you will name, and do not rebuild an id, a status or an " +
		"approval from the summary or from memory.]"
	orbitContextResetNoteFree = "[Orbit: this conversation was compacted or resumed since your last turn. Before you act " +
		"on this message, read again from Orbit's tools any record you will name, and do not rebuild an id, a status or " +
		"an approval from the summary or from memory.]"
)

// withContextResetNote is text as the engine is to read it: led by the note when the conversation was reset, the one
// for a task's run when taskSession is set.
func withContextResetNote(text string, reset, taskSession bool) string {
	if !reset {
		return text
	}
	note := orbitContextResetNoteFree
	if taskSession {
		note = orbitContextResetNote
	}
	if text == "" {
		return note
	}
	return note + "\n\n" + text
}

// isClaudeSlashCommand reports whether Claude Code reads text as a slash command: a leading `/name`. A path such as
// `/root/x is missing` is not one.
func isClaudeSlashCommand(text string) bool {
	name, _, _ := strings.Cut(text, " ")
	name, _, _ = strings.Cut(name, "\n")
	return len(name) > 1 && name[0] == '/' && !strings.Contains(name[1:], "/")
}
