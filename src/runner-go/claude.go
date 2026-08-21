package main

import (
	"context"
	"strings"
)

// ExecResult is the normalized outcome of one Claude Code run.
type ExecResult struct {
	Status          string
	Result          string
	Subtype         string
	ErrorMsg        string
	ClaudeSessionID string
	NumTurns        int
	DurationMs      int
	CostUsd         float64
	Usage           *TokenUsage
	ModelUsage      map[string]interface{}
}

type emitFn func(eventType string, payload map[string]interface{})

// emitTurnFn files an event against a named conversation turn rather than the session's
// current attribution. See the emitFor closure in session.go for the one case that needs it.
type emitTurnFn func(turnID, eventType string, payload map[string]interface{})

func handleMessage(msg map[string]interface{}, emit emitFn, bg *bgTailer) {
	// A sub-agent's messages (spawned by the Task tool) carry the spawning Task's
	// tool_use id here; stamp it onto every event so the UI can nest the sub-agent's
	// transcript under that call. "" for the top-level agent.
	parentID, _ := msg["parent_tool_use_id"].(string)
	withParent := func(p map[string]interface{}) map[string]interface{} {
		if parentID != "" {
			p["parentToolUseId"] = parentID
		}
		return p
	}
	switch msg["type"] {
	case "system":
		// The init handshake carries the CLI's own slash registry — built-in skills, plugin
		// skills and namespaced commands the .claude/ scan can't see. Learn it so the
		// composer stops rejecting them (see slash_registry.go).
		if msg["subtype"] == "init" {
			slashReg.learn(stringsFromJSON(msg["slash_commands"]), stringsFromJSON(msg["skills"]))
		}
		sys := map[string]interface{}{
			"subtype":   msg["subtype"],
			"model":     msg["model"],
			"sessionId": msg["session_id"],
		}
		// A compaction boundary is the one system message carrying something worth storing: it
		// marks where Claude dropped history, which a transcript rebuild has to replay around
		// (transcript_rebuild.go). The wire spells these snake_case; the on-disk transcript
		// spells the same fields camelCase, and the rest of Orbit is camelCase, so normalize here.
		if md := msg["compact_metadata"]; md != nil {
			sys["compactMetadata"] = md
		}
		emit(evSystem, sys)
	case "assistant":
		message, _ := msg["message"].(map[string]interface{})
		content, _ := message["content"].([]interface{})
		for _, c := range content {
			block, _ := c.(map[string]interface{})
			switch block["type"] {
			case "text":
				emit(evAssistant, withParent(map[string]interface{}{"text": block["text"]}))
			case "thinking":
				emit(evThinking, withParent(map[string]interface{}{"text": block["thinking"]}))
			case "redacted_thinking":
				// Encrypted reasoning (block["data"]) the user can't read — surface a
				// placeholder so the block isn't silently missing, like Claude Code Web.
				emit(evThinking, withParent(map[string]interface{}{"text": "[redacted thinking]", "redacted": true}))
			case "tool_use":
				emit(evToolUse, withParent(map[string]interface{}{
					"id": block["id"], "name": block["name"], "input": block["input"],
				}))
			}
		}
	case "user":
		// Tool results arrive as user-role messages (the Anthropic SSE protocol puts
		// tool_result blocks in a `user` message, not an assistant one). Emit only
		// those: the user's own typed turns are emitted from the inbox and echoed back
		// here by --replay-user-messages, so re-emitting their text would double them.
		message, _ := msg["message"].(map[string]interface{})
		// A background-task lifecycle notification arrives as a user message whose content is
		// a plain "<task-notification>…</task-notification>" string (not tool_result blocks) —
		// turn it into a durable background_task event and stop that task's output tail.
		if s, ok := message["content"].(string); ok {
			if bgTaskFromNotification(s, emit, bg) {
				break
			}
			// Claude's own compaction summary arrives the same way — a synthetic user message
			// holding a plain string. It is the only record of what the dropped history said, so
			// store it: a later rebuild replays this instead of paying to summarize that history
			// again. Filed as a system event rather than a new event type because no client
			// renders it and unknown system subtypes are already ignored everywhere.
			if isCompactSummaryMessage(msg, s) {
				emit(evSystem, map[string]interface{}{"subtype": "compact_summary", "text": s})
				break
			}
		}
		content, _ := message["content"].([]interface{})
		for _, c := range content {
			block, _ := c.(map[string]interface{})
			if block["type"] == "tool_result" {
				emit(evToolResult, withParent(map[string]interface{}{
					"toolUseId": block["tool_use_id"],
					"content":   block["content"],
					"isError":   block["is_error"],
				}))
				// A Bash(run_in_background) result confirms "running in background with ID…"
				// and the output file path — start tailing it for live output.
				if bg != nil {
					if cs, ok := block["content"].(string); ok {
						bg.onToolResult(asString(block["tool_use_id"]), cs)
					}
				}
			}
		}
	case "stream_event":
		// Partial-message deltas (--include-partial-messages) drive live typing. Only
		// the text/thinking deltas are surfaced as streaming animation; the durable
		// assistant/thinking events carry the authoritative full text.
		event, _ := msg["event"].(map[string]interface{})
		delta, _ := event["delta"].(map[string]interface{})
		switch delta["type"] {
		case "text_delta":
			emit(evTextDelta, map[string]interface{}{"text": delta["text"]})
		case "thinking_delta":
			emit(evThinkingDelta, map[string]interface{}{"text": delta["thinking"]})
		}
	}
}

// compactSummaryMarker opens the summary Claude writes after compacting a conversation.
const compactSummaryMarker = "This session is being continued from a previous conversation"

// isCompactSummaryMessage reports whether a string-content user message is Claude's post-compaction
// summary rather than a replayed user turn. `isSynthetic` alone would trust a flag we don't own for
// a message that silently changes what the agent remembers; the marker alone would misread a user
// who pastes that sentence. Both together is the conservative reading.
func isCompactSummaryMessage(msg map[string]interface{}, content string) bool {
	synthetic, _ := msg["isSynthetic"].(bool)
	return synthetic && strings.HasPrefix(strings.TrimSpace(content), compactSummaryMarker)
}

// isAPIError reports whether a result/assistant text carries a Claude Code API error
// (e.g. content filtering, a 4xx/5xx). Such errors come back as an assistant text block
// plus a `result` with subtype "success" and no `is_error`, so they slip past the
// is_error/subtype check in resultFrom. We key on the stable "API Error" prefix Claude
// Code uses. Heuristic; keep in sync with isApiErrorText in @orbit/shared.
func isAPIError(s string) bool {
	return strings.HasPrefix(strings.TrimSpace(s), "API Error")
}

// isResumeCarrierResult reports whether a `result` closes a turn claude invented for itself
// rather than one Orbit fed it.
//
// A `--resume` with a queued `<task-notification>` to hand over — a background shell that was
// still running when the previous process died — wraps it in a synthetic carrier turn of its
// own: the meta prompt "Continue from where you left off." answered locally with "No response
// requested." That turn ends with a `result` like any other, but no fed message asked for it,
// so completing a turn on it retires the message the user has just sent before the model has
// even read it (and puts every later result one turn out of step).
//
// The carrier is the one result that produced nothing at all: no API round trip (numTurns 0)
// and not a word on the wire. A slash command claude resolves client-side (`/help`) is also
// numTurns 0, but it streams its answer as assistant text and repeats it in `result`, and it
// IS a real turn that must be acked — hence both text checks. Errors are excluded outright: a
// failed turn reports no work either, and must still reach the control plane.
func isResumeCarrierResult(r ExecResult, streamedText string) bool {
	return r.Subtype == "success" && r.Status == stSucceeded &&
		r.NumTurns == 0 && r.Result == "" && streamedText == ""
}

// isAuthError reports whether a result/assistant text carries a sign-in failure — this
// machine's stored credentials being gone, expired or rejected ("Failed to authenticate:
// OAuth session expired and could not be refreshed"). It arrives the same way an API error
// does (assistant text + a "success" result), so it needs the same rescue from resultFrom;
// it's split out because the control plane renders it as sign-in guidance rather than a bare
// error. Heuristic; keep in sync with isAuthErrorText in @orbit/shared.
func isAuthError(s string) bool {
	return strings.HasPrefix(strings.TrimSpace(s), "Failed to authenticate")
}

// asAuthError puts a rejected-credentials error into the shape the clients recognise.
//
// Claude Code says "Failed to authenticate" itself; codex reports the same condition as a
// bare transport failure from its own API call ("unexpected status 401 Unauthorized: Missing
// bearer or basic authentication in header"), which renders as one red line about a network
// hiccup and offers the user nothing. Prefixing it earns the sign-in card, and the original
// text is kept — which credential was rejected is the useful part, and the card picks the
// remedy from the session's provider (this machine's login, or an API key in Providers).
//
// Deliberately narrow: this runs only on the engine's own protocol errors, never on tool
// output, so a 401 here is always the engine's credentials being refused.
func asAuthError(msg string) string {
	if isAuthError(msg) {
		return msg
	}
	low := strings.ToLower(msg)
	if !strings.Contains(low, "401") && !strings.Contains(low, "missing bearer") {
		return msg
	}
	if !strings.Contains(low, "unauthorized") && !strings.Contains(low, "missing bearer") {
		return msg
	}
	return "Failed to authenticate: " + msg
}

// contextTokensFromAssistant returns the context-window occupancy after a *top-level*
// assistant message: the tokens sent to produce it (fresh input + cache reads + cache
// writes) plus the tokens it generated — the same figure Claude Code's own context
// gauge shows. Sub-agent messages (a Task tool's own thread, `parent_tool_use_id` set)
// run in a separate context, so they're ignored. Returns 0 when the message isn't a
// top-level assistant turn or carries no usage.
//
// Deliberately NOT the turn's trailing result.usage: that SUMS usage across every step
// of the turn, so cache_read alone dwarfs the real window. The latest assistant
// message's own usage is the actual current occupancy. (Claude's input_tokens excludes
// cached tokens — cache_read/creation are counted separately — so all four add up.)
func contextTokensFromAssistant(msg map[string]interface{}) int {
	if p, _ := msg["parent_tool_use_id"].(string); p != "" {
		return 0
	}
	message, _ := msg["message"].(map[string]interface{})
	u, ok := message["usage"].(map[string]interface{})
	if !ok {
		return 0
	}
	return toInt(u["input_tokens"]) + toInt(u["cache_read_input_tokens"]) +
		toInt(u["cache_creation_input_tokens"]) + toInt(u["output_tokens"])
}

// assistantText concatenates the text blocks of an `assistant` stream-json message.
func assistantText(msg map[string]interface{}) string {
	message, _ := msg["message"].(map[string]interface{})
	content, _ := message["content"].([]interface{})
	var b strings.Builder
	for _, c := range content {
		block, _ := c.(map[string]interface{})
		if block["type"] == "text" {
			if t, ok := block["text"].(string); ok {
				b.WriteString(t)
			}
		}
	}
	return b.String()
}

func resultFrom(msg map[string]interface{}, ctx context.Context) ExecResult {
	subtype, _ := msg["subtype"].(string)
	isErr := false
	if b, ok := msg["is_error"].(bool); ok && b {
		isErr = true
	}
	if strings.HasPrefix(subtype, "error") {
		isErr = true
	}
	status := stSucceeded
	if ctx.Err() != nil {
		status = stCancelled
	} else if isErr {
		status = stFailed
	}
	r := ExecResult{Status: status, Subtype: subtype}
	r.Result, _ = msg["result"].(string)
	r.ClaudeSessionID, _ = msg["session_id"].(string)
	r.NumTurns = toInt(msg["num_turns"])
	r.DurationMs = toInt(msg["duration_ms"])
	r.CostUsd = toFloat(msg["total_cost_usd"])
	if u, ok := msg["usage"].(map[string]interface{}); ok {
		r.Usage = &TokenUsage{
			InputTokens:              toInt(u["input_tokens"]),
			OutputTokens:             toInt(u["output_tokens"]),
			CacheCreationInputTokens: toInt(u["cache_creation_input_tokens"]),
			CacheReadInputTokens:     toInt(u["cache_read_input_tokens"]),
		}
	}
	if mu, ok := msg["modelUsage"].(map[string]interface{}); ok {
		r.ModelUsage = mu
	}
	return r
}

func toInt(v interface{}) int {
	if f, ok := v.(float64); ok {
		return int(f)
	}
	return 0
}

func toFloat(v interface{}) float64 {
	if f, ok := v.(float64); ok {
		return f
	}
	return 0
}
