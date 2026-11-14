package main

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

const orbitContextResetNote = "[Orbit: this conversation was compacted or resumed since your last turn. Before you act " +
	"on this message, read what you are working on again from Orbit's tools (task_get with no id reads this session's " +
	"task), and do not rebuild an id, a status or an approval from the summary or from memory.]"

// withContextResetNote is text as the engine is to read it: led by the note when the conversation was reset.
func withContextResetNote(text string, reset bool) string {
	if !reset {
		return text
	}
	if text == "" {
		return orbitContextResetNote
	}
	return orbitContextResetNote + "\n\n" + text
}
