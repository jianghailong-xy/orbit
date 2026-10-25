package main

import "context"

// The non-Claude half of next-message suggestions (docs/prompt-suggestions-design.md §8 P2).
// Every engine but Claude Code has no --prompt-suggestions of its own (design §1.2), so when
// the control plane still asks for them the guess comes from the server: after a turn that ran
// to an answer, the runner POSTs for it, and the server writes one with DeepSeek from just that
// turn. What comes back is filed as a prompt_suggestion event exactly like the engine's own —
// the runner numbers its seq the same way and the clients never tell the two apart. Best-effort
// end to end: one request, no retry, and silence whenever the answer is late, missing, or stale.

// turnEndSucceeded reports whether a turn_end payload closes a turn that ran to an answer. The
// engines spell it two ways: claude, antigravity and opencode emit "success"; codex, kimi and
// dsh emit "completed".
func turnEndSucceeded(payload map[string]interface{}) bool {
	subtype, _ := payload["subtype"].(string)
	return subtype == "success" || subtype == "completed"
}

// fetchOrbitSuggestion asks the control plane for its guess and hands the text to emit — unless
// the world moved on while the guess was being made: stale says an event was buffered after the
// turn's own end (a new message answers what the suggestion was guessing at) or a turn is
// already running, and filing then would offer the person a reply to themselves.
func fetchOrbitSuggestion(ctx context.Context, t *Transport, sessionID, turnID string, stale func() bool, emit func(text string)) {
	text, ok := t.turnSuggestion(ctx, sessionID, turnID)
	if !ok || stale() {
		return
	}
	emit(text)
}
