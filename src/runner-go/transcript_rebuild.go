package main

// Rebuilding a Claude Code transcript from Orbit's event archive.
//
// `claude --resume <uuid>` reads ~/.claude/projects/<cwd-slug>/<uuid>.jsonl and nothing else. On
// a machine that never ran the session — a different runner, a wiped ~/.claude, a moved
// worktree — it fails with "No conversation found with session ID" and the whole conversation is
// gone even though Orbit still has every event. This rebuilds that file first.
//
// The replay is bounded. Orbit's log is the history BEFORE any of Claude's own compactions, so
// replaying a long session whole would not fit the context window. Everything past the budget is
// summarized behind a synthetic `compact_boundary` — the same record Claude writes when it
// compacts itself. Its `parentUuid: null` cuts the chain the CLI walks back from the tail, so
// the pre-boundary records stay in the file (and in the transcript UI) without entering the
// model's context.

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	// Estimated tokens of verbatim history allowed back into the model's context. Sized well
	// under a 200k window so the agent's system prompt, its tool definitions and the turn that
	// triggered the resume still fit alongside the replay.
	transcriptReplayTokenBudget = 100000
	// Ceiling on what the one-shot summarizer is fed, so condensing a million-token session
	// stays a single bounded call. History older than this is dropped with a note in the digest.
	transcriptSummaryInputTokenBudget = 60000
	// A fast, cheap tier: the summary is prose about a conversation, not fresh reasoning over
	// the code. Same reasoning as commitMsgModel.
	transcriptSummaryModel   = "sonnet"
	transcriptSummaryTimeout = 3 * time.Minute
	// Stored tool payloads reach ~1MB, so ask for modest pages rather than the server's cap.
	transcriptFetchPageSize = 300
	// Backstop so a runaway log can't make a rebuild page forever.
	transcriptFetchMaxEvents = 20000
	// Per-tool-result cap. Claude's own tools truncate their output long before this; the cap
	// only stops one pathological result from crowding out the rest of the replay.
	transcriptToolResultMaxRunes = 20000
)

// ensureClaudeTranscript rebuilds the session's local Claude transcript when this machine does
// not have it, so the caller's `--resume` finds a conversation. Best-effort throughout: on any
// failure it logs and returns, leaving the spawn to fail exactly as it does today.
func ensureClaudeTranscript(ctx context.Context, t *Transport, job *ClaimedSession, execDir string, emit emitFn) {
	if findClaudeTranscript(job.SessionUUID) != "" {
		return
	}
	path, err := claudeTranscriptPath(execDir, job.SessionUUID)
	if err != nil {
		logln("transcript rebuild: cannot resolve transcript path:", err)
		return
	}
	events, err := fetchStoredEvents(ctx, t, job.SessionID)
	if err != nil {
		logln("transcript rebuild: cannot fetch stored events:", err)
		return
	}
	msgs, storedSummary, storedCut := replayMessagesFromEvents(events)
	if len(msgs) == 0 {
		logln("transcript rebuild: no replayable history for session", job.SessionID)
		return
	}
	cut, summary := planReplay(msgs, storedSummary, storedCut, func(head []replayMessage) string {
		return summarizeReplayHead(ctx, head)
	})
	data, err := renderTranscriptJSONL(msgs, cut, summary, job, execDir)
	if err != nil {
		logln("transcript rebuild: cannot render transcript:", err)
		return
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		logln("transcript rebuild: cannot create project dir:", err)
		return
	}
	if err := writeFileAtomically(path, data, 0o644); err != nil {
		logln("transcript rebuild: cannot write transcript:", err)
		return
	}
	logln("transcript rebuild: restored", len(msgs), "messages for", job.SessionID,
		"("+strconv.Itoa(cut), "summarized behind a compact boundary)")
	// No client renders this, but it is the durable answer to "why did the agent forget the
	// earlier part of this session" — the one question a silently-degraded resume provokes.
	emit(evSystem, map[string]interface{}{
		"subtype":    "transcript_rebuilt",
		"messages":   len(msgs),
		"summarized": cut,
	})
}

// claudeTranscriptPath is where Claude Code keeps one session's transcript. `--resume` looks ONLY
// in the directory for the process's own cwd — the same session id under a different project
// directory comes back as "No conversation found" — so the escaping has to match Claude's
// exactly: every character outside [A-Za-z0-9] becomes '-', with runs left uncollapsed
// (/root/.orbit/x → -root--orbit-x). Non-ASCII path segments are the one untested corner; they
// degrade to a directory Claude won't read, which is the same failure as not rebuilding at all.
func claudeTranscriptPath(cwd, sessionUUID string) (string, error) {
	base := os.Getenv("CLAUDE_CONFIG_DIR")
	if base == "" {
		home, err := os.UserHomeDir()
		if err != nil || home == "" {
			return "", fmt.Errorf("no home directory")
		}
		base = filepath.Join(home, ".claude")
	}
	abs, err := filepath.Abs(cwd)
	if err != nil {
		return "", err
	}
	return filepath.Join(base, "projects", claudeProjectSlug(abs), sessionUUID+".jsonl"), nil
}

func claudeProjectSlug(path string) string {
	var b strings.Builder
	for _, r := range path {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' {
			b.WriteRune(r)
			continue
		}
		b.WriteByte('-')
	}
	return b.String()
}

func fetchStoredEvents(ctx context.Context, t *Transport, sessionID string) ([]StoredEvent, error) {
	var all []StoredEvent
	after := 0
	for len(all) < transcriptFetchMaxEvents {
		page, err := t.sessionEvents(ctx, sessionID, after, transcriptFetchPageSize)
		if err != nil {
			return nil, err
		}
		if len(page.Events) == 0 {
			break
		}
		all = append(all, page.Events...)
		after = page.Events[len(page.Events)-1].Seq
		if !page.HasMore {
			break
		}
	}
	return all, nil
}

// replayMessage is one message to put back into the rebuilt transcript: a role plus the content
// blocks Claude stores under `message.content`. Orbit records one event per content block, which
// is also how Claude writes its own transcript, so the mapping is 1:1.
type replayMessage struct {
	role   string // "user" | "assistant"
	blocks []map[string]interface{}
	ts     time.Time
	tokens int
}

func newReplayMessage(role string, blocks []map[string]interface{}, ts time.Time) replayMessage {
	b, _ := json.Marshal(blocks)
	// ~3 bytes per token is right for CJK and deliberately pessimistic for English, so the
	// budget errs toward summarizing a little more rather than overflowing the window.
	return replayMessage{role: role, blocks: blocks, ts: ts, tokens: len(b)/3 + 1}
}

// replayMessagesFromEvents turns Orbit's stored events into the message sequence to replay, plus
// the most recent summary Claude itself wrote when it compacted this session and the index where
// the history it replaced ends. That pair lets a rebuild reuse Claude's own summary instead of
// paying to write a new one; it is empty for sessions recorded before the runner learned to store
// it, and for sessions that never compacted.
//
// Thinking blocks are deliberately dropped: Orbit keeps their text but not the server-issued
// `signature`, and they cost context without saying anything the assistant text and the tool
// calls don't already carry.
//
// Tool pairing is repaired on the way through. The API rejects a tool_use with no matching
// tool_result — which is exactly what a session killed mid-tool leaves behind — so an unanswered
// call gets a synthetic result, and a result whose call never reached the log is dropped.
func replayMessagesFromEvents(events []StoredEvent) (msgs []replayMessage, storedSummary string, storedCut int) {
	var out []replayMessage
	called := map[string]bool{} // tool_use ids that made it into the replay
	var pending []string        // emitted but not yet answered, in call order

	// flushPending answers every still-open tool call before a message that isn't its result,
	// keeping the user/assistant alternation the API requires.
	flushPending := func(ts time.Time) {
		if len(pending) == 0 {
			return
		}
		blocks := make([]map[string]interface{}, 0, len(pending))
		for _, id := range pending {
			blocks = append(blocks, map[string]interface{}{
				"type":        "tool_result",
				"tool_use_id": id,
				"content":     "[no result recorded: the session ended before this tool returned]",
				"is_error":    true,
			})
		}
		pending = nil
		out = append(out, newReplayMessage("user", blocks, ts))
	}

	for _, e := range events {
		switch e.Type {
		case evSystem:
			// Claude compacted here: everything up to this point is what its summary replaced.
			// A later compaction supersedes an earlier one, so the last one wins.
			if e.Payload["subtype"] == "compact_summary" {
				if text := strings.TrimSpace(asString(e.Payload["text"])); text != "" {
					flushPending(e.Ts)
					storedSummary, storedCut = text, len(out)
				}
			}
		case evUser:
			text := asString(e.Payload["text"])
			if strings.TrimSpace(text) == "" {
				continue
			}
			flushPending(e.Ts)
			out = append(out, newReplayMessage("user",
				[]map[string]interface{}{{"type": "text", "text": text}}, e.Ts))
		case evAssistant:
			text := asString(e.Payload["text"])
			if strings.TrimSpace(text) == "" {
				continue
			}
			flushPending(e.Ts)
			out = append(out, newReplayMessage("assistant",
				[]map[string]interface{}{{"type": "text", "text": text}}, e.Ts))
		case evToolUse:
			id := asString(e.Payload["id"])
			if id == "" {
				continue // unaddressable: no result could ever be matched to it
			}
			name := asString(e.Payload["name"])
			if name == "" {
				name = "tool" // Codex records some calls without one; the API needs something
			}
			input := e.Payload["input"]
			if input == nil {
				input = map[string]interface{}{}
			}
			called[id] = true
			pending = append(pending, id)
			out = append(out, newReplayMessage("assistant", []map[string]interface{}{
				{"type": "tool_use", "id": id, "name": name, "input": input},
			}, e.Ts))
		case evToolResult:
			id := asString(e.Payload["toolUseId"])
			if id == "" || !called[id] {
				continue // orphan: its call never reached the log, so replaying it would error
			}
			pending = removeString(pending, id)
			isErr, _ := e.Payload["isError"].(bool)
			out = append(out, newReplayMessage("user", []map[string]interface{}{{
				"type":        "tool_result",
				"tool_use_id": id,
				"content":     clip(toolResultText(e.Payload["content"]), transcriptToolResultMaxRunes),
				"is_error":    isErr,
			}}, e.Ts))
		}
	}
	if len(out) > 0 {
		flushPending(out[len(out)-1].ts)
	}
	// The conversation has to open on a real user turn — not on a tool_result whose call is
	// behind the start — which is also the invariant splitForReplay relies on when it snaps a
	// budget cut forward. Trimming shifts every index, storedCut included.
	for i, m := range out {
		if isUserTurnStart(m) {
			return out[i:], storedSummary, max(0, storedCut-i)
		}
	}
	return nil, "", 0
}

// toolResultText flattens a tool result to text. Content is usually already a string; the block
// form is reduced to its text parts, so an image returned by a tool is not replayed.
func toolResultText(v interface{}) string {
	switch c := v.(type) {
	case string:
		return c
	case []interface{}:
		var b strings.Builder
		for _, it := range c {
			if m, ok := it.(map[string]interface{}); ok && m["type"] == "text" {
				b.WriteString(asString(m["text"]))
			}
		}
		return b.String()
	case nil:
		return ""
	default:
		b, _ := json.Marshal(c)
		return string(b)
	}
}

func removeString(xs []string, want string) []string {
	for i, x := range xs {
		if x == want {
			return append(xs[:i:i], xs[i+1:]...)
		}
	}
	return xs
}

// planReplay decides where the verbatim replay starts and what stands in for the history before
// it. Claude's own compaction summary wins when the runner captured one and what follows it still
// fits the budget: it costs nothing, and it is the very text the live session was running on.
// Otherwise the budget picks the cut and `summarize` writes the stand-in — passed in so the
// decision can be tested without spending a model call on it.
func planReplay(msgs []replayMessage, storedSummary string, storedCut int, summarize func([]replayMessage) string) (int, string) {
	if storedSummary != "" && storedCut > 0 && storedCut <= len(msgs) {
		tail := 0
		for _, m := range msgs[storedCut:] {
			tail += m.tokens
		}
		if tail <= transcriptReplayTokenBudget {
			return storedCut, storedSummary
		}
	}
	cut := splitForReplay(msgs, transcriptReplayTokenBudget)
	if cut == 0 {
		return 0, ""
	}
	return cut, summarize(msgs[:cut])
}

// splitForReplay picks the first message to replay verbatim. It walks back from the newest until
// the token budget is spent, then snaps FORWARD to the start of a user turn, so the replayed
// segment never opens on a tool_result whose call was left behind the boundary. 0 means the whole
// history fits and no compaction is needed.
func splitForReplay(msgs []replayMessage, budget int) int {
	total := 0
	for _, m := range msgs {
		total += m.tokens
	}
	if total <= budget {
		return 0
	}
	spent, cut := 0, len(msgs)
	for i := len(msgs) - 1; i >= 0; i-- {
		if spent+msgs[i].tokens > budget {
			break
		}
		spent += msgs[i].tokens
		cut = i
	}
	for i := cut; i < len(msgs); i++ {
		if isUserTurnStart(msgs[i]) {
			return i
		}
	}
	// One enormous final turn: nothing inside the budget starts a turn. Keeping that whole turn
	// is the only split that doesn't orphan its tool results, so take it and accept the overrun.
	for i := len(msgs) - 1; i >= 0; i-- {
		if isUserTurnStart(msgs[i]) {
			return i
		}
	}
	return 0
}

func isUserTurnStart(m replayMessage) bool {
	return m.role == "user" && len(m.blocks) > 0 && m.blocks[0]["type"] == "text"
}

const transcriptSummaryPrompt = `Below is the earlier part of a coding session between a user and an AI agent, which no longer fits in the context window.

Write a summary the agent can use to continue the work. Cover, in this order:
1. What the user asked for, in their own terms, including any later corrections.
2. Decisions taken and the reasoning behind them.
3. Files created or changed, and what changed in each.
4. What is verified working, and what is still open or broken.
5. Anything the user explicitly asked to avoid or to remember.

Be specific — keep file paths, identifiers, commands and error text. No preamble, no closing remarks, just the summary.

Conversation:
`

// summarizeReplayHead condenses the history that did not fit into the prose that goes after the
// compact boundary. Best-effort and one-shot: on any failure (claude missing, not signed in,
// timeout, empty reply) the mechanical digest is used as the summary instead, so a rebuild is
// never blocked on the summarizer. Runs in a throwaway temp dir so the target repo's CLAUDE.md
// and MCP config can't slow it down or pull in tools.
func summarizeReplayHead(ctx context.Context, head []replayMessage) string {
	digest := replayDigest(head, transcriptSummaryInputTokenBudget)
	tmp, err := os.MkdirTemp("", "orbit-tsum-")
	if err != nil {
		return digest
	}
	defer os.RemoveAll(tmp)
	cctx, cancel := context.WithTimeout(ctx, transcriptSummaryTimeout)
	defer cancel()
	cmd := exec.CommandContext(cctx, "claude", "-p", transcriptSummaryPrompt+digest,
		"--model", transcriptSummaryModel, "--output-format", "text")
	cmd.Dir = tmp
	out, err := cmd.Output()
	if err == nil {
		if s := strings.TrimSpace(string(out)); s != "" {
			return s
		}
	}
	logln("transcript rebuild: summarizer unavailable, replaying a mechanical digest:", err)
	return digest
}

// replayDigest renders the summarized-away history as plain text, bounded to `budget` estimated
// tokens by dropping the OLDEST messages — the recent end of what got cut is what the next turn
// is most likely to need. Doubles as the summarizer's input and as the fallback summary.
func replayDigest(msgs []replayMessage, budget int) string {
	start, spent := 0, 0
	for i := len(msgs) - 1; i >= 0; i-- {
		if spent+msgs[i].tokens > budget {
			start = i + 1
			break
		}
		spent += msgs[i].tokens
	}
	var b strings.Builder
	if start > 0 {
		fmt.Fprintf(&b, "(%d earlier messages omitted)\n\n", start)
	}
	for _, m := range msgs[start:] {
		for _, blk := range m.blocks {
			switch blk["type"] {
			case "text":
				fmt.Fprintf(&b, "%s: %s\n\n", m.role, asString(blk["text"]))
			case "tool_use":
				in, _ := json.Marshal(blk["input"])
				fmt.Fprintf(&b, "assistant called %s(%s)\n\n", asString(blk["name"]), clip(string(in), 500))
			case "tool_result":
				fmt.Fprintf(&b, "tool result: %s\n\n", clip(asString(blk["content"]), 1000))
			}
		}
	}
	return b.String()
}

// rebuiltSummaryPreamble opens a summary this rebuild had to write itself. Claude's own compaction
// says the session "ran out of context"; this says what actually happened, since the agent reads it
// and a wrong explanation of its own missing memory is worse than none.
const rebuiltSummaryPreamble = "This session is being continued from a previous conversation " +
	"whose local transcript was no longer on this machine and has been reconstructed from Orbit's " +
	"event archive. The summary below covers the earlier portion of the conversation.\n\nSummary:\n"

// withCompactPreamble leaves a summary Claude wrote alone — it already opens with its own
// explanation — and introduces one we generated.
func withCompactPreamble(summary string) string {
	s := strings.TrimSpace(summary)
	if strings.HasPrefix(s, compactSummaryMarker) {
		return s
	}
	return rebuiltSummaryPreamble + s
}

// renderTranscriptJSONL writes the replay as Claude Code's transcript format: one JSON record per
// line, each pointing at its predecessor through parentUuid. When `cut` > 0 the records before it
// are still written — the transcript UI shows the whole history — but a compact boundary sits
// between them and the rest with parentUuid: null, so the CLI's walk back from the tail stops at
// the summary and the older records never reach the model.
func renderTranscriptJSONL(msgs []replayMessage, cut int, summary string, job *ClaimedSession, cwd string) ([]byte, error) {
	compacting := cut > 0 && strings.TrimSpace(summary) != ""
	if !compacting {
		cut = 0
	}
	base := map[string]interface{}{
		"isSidechain": false,
		"userType":    "external",
		"cwd":         cwd,
		"sessionId":   job.SessionUUID,
		"version":     claudeCLIVersion(),
		"gitBranch":   job.Branch,
	}
	rec := func(extra map[string]interface{}) map[string]interface{} {
		r := make(map[string]interface{}, len(base)+len(extra))
		for k, v := range base {
			r[k] = v
		}
		for k, v := range extra {
			r[k] = v
		}
		return r
	}

	var records []map[string]interface{}
	var parent interface{} // nil renders as the JSON null that opens a chain
	n := 0
	nextUUID := func() string {
		n++
		return recordUUID(job.SessionUUID, n)
	}
	appendMessages := func(ms []replayMessage) {
		for _, m := range ms {
			id := nextUUID()
			records = append(records, rec(map[string]interface{}{
				"parentUuid": parent,
				"type":       m.role,
				"uuid":       id,
				"timestamp":  m.ts.UTC().Format(time.RFC3339Nano),
				"message":    replayMessageBody(m, job.Agent.Model, id),
			}))
			parent = id
		}
	}

	appendMessages(msgs[:cut])
	if compacting {
		headTokens := 0
		for _, m := range msgs[:cut] {
			headTokens += m.tokens
		}
		boundaryID, summaryID := nextUUID(), nextUUID()
		// cut == len(msgs) when the session compacted and then ended: a summary with no tail.
		boundaryAt := msgs[len(msgs)-1]
		if cut < len(msgs) {
			boundaryAt = msgs[cut]
		}
		ts := boundaryAt.ts.UTC().Format(time.RFC3339Nano)
		records = append(records, rec(map[string]interface{}{
			"parentUuid":        nil, // cuts the chain: everything above stays out of context
			"logicalParentUuid": parent,
			"type":              "system",
			"subtype":           "compact_boundary",
			"content":           "Conversation compacted",
			"isMeta":            false,
			"level":             "info",
			"uuid":              boundaryID,
			"timestamp":         ts,
			"compactMetadata": map[string]interface{}{
				"trigger":           "auto",
				"preTokens":         headTokens,
				"preservedSegment":  map[string]interface{}{"headUuid": summaryID, "anchorUuid": summaryID, "tailUuid": summaryID},
				"preservedMessages": map[string]interface{}{"anchorUuid": summaryID, "uuids": []string{summaryID}},
			},
		}))
		records = append(records, rec(map[string]interface{}{
			"parentUuid":                boundaryID,
			"type":                      "user",
			"isCompactSummary":          true,
			"isVisibleInTranscriptOnly": true,
			"uuid":                      summaryID,
			"timestamp":                 ts,
			"message": map[string]interface{}{
				"role":    "user",
				"content": withCompactPreamble(summary),
			},
		}))
		parent = summaryID
	}
	appendMessages(msgs[cut:])

	var b strings.Builder
	for _, r := range records {
		line, err := json.Marshal(r)
		if err != nil {
			return nil, err
		}
		b.Write(line)
		b.WriteByte('\n')
	}
	return []byte(b.String()), nil
}

func replayMessageBody(m replayMessage, model, recordID string) map[string]interface{} {
	if m.role != "assistant" {
		return map[string]interface{}{"role": "user", "content": m.blocks}
	}
	stop := "end_turn"
	if len(m.blocks) > 0 && m.blocks[len(m.blocks)-1]["type"] == "tool_use" {
		stop = "tool_use"
	}
	return map[string]interface{}{
		"id":            "msg_" + strings.ReplaceAll(recordID, "-", "")[:24],
		"type":          "message",
		"role":          "assistant",
		"model":         model,
		"content":       m.blocks,
		"stop_reason":   stop,
		"stop_sequence": nil,
		// Replayed history is not re-billed, but the field is part of the record shape.
		"usage": map[string]interface{}{
			"input_tokens": 0, "output_tokens": m.tokens,
			"cache_creation_input_tokens": 0, "cache_read_input_tokens": 0,
		},
	}
}

// recordUUID derives a record's id from the session and its position, so rebuilding the same
// history twice produces a byte-identical file. Shaped like a v4 UUID because that is what
// Claude writes and reads back as the parent/child chain.
func recordUUID(sessionUUID string, i int) string {
	sum := sha256.Sum256([]byte(sessionUUID + ":transcript:" + strconv.Itoa(i)))
	var id [16]byte
	copy(id[:], sum[:16])
	id[6] = (id[6] & 0x0f) | 0x40 // UUID v4
	id[8] = (id[8] & 0x3f) | 0x80 // RFC 4122 variant
	return fmt.Sprintf("%x-%x-%x-%x-%x", id[0:4], id[4:6], id[6:8], id[8:10], id[10:16])
}

var (
	claudeVersionOnce sync.Once
	claudeVersionVal  string
)

// claudeCLIVersion is the `version` field Claude stamps on every record. Read from the CLI rather
// than hardcoded: it is metadata we don't own, and a made-up version is exactly the kind of thing
// a future CLI would branch a migration on.
func claudeCLIVersion() string {
	claudeVersionOnce.Do(func() {
		claudeVersionVal = "0.0.0"
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		out, err := exec.CommandContext(ctx, "claude", "--version").Output()
		if err != nil {
			return
		}
		if f := strings.Fields(strings.TrimSpace(string(out))); len(f) > 0 && f[0] != "" {
			claudeVersionVal = f[0]
		}
	})
	return claudeVersionVal
}
