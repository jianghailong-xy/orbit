package main

// Importing a local Claude Code transcript (`orbit session import`).
//
// The inverse of transcript_rebuild.go's replayMessagesFromEvents: where a rebuild turns
// Orbit's stored events back into transcript records, an import turns Claude's transcript
// records back into the events Orbit stores for the transcript UI and search. The two are
// pinned together by a round-trip self-check inside parseImportTranscript, so the inverse
// cannot drift from the forward conversion silently — a conversion whose replay does not
// reproduce the transcript refuses the import instead of showing a garbled history.
//
// The transcript file itself is copied into the session's own ~/.claude/projects/<slug>/
// directory (cwd rewritten to the session checkout) so the `--resume` spawn reads the
// original conversation, thinking blocks and all, not a reconstruction.

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"time"
)

// importRecord is one JSONL line of a Claude transcript, cut down to the fields the import
// reads. Everything else is preserved verbatim by the copy, not parsed here.
type importRecord struct {
	Type      string `json:"type"`
	Cwd       string `json:"cwd"`
	AiTitle   string `json:"aiTitle"`
	Timestamp string `json:"timestamp"`
	// Sidechain records are discarded conversation branches; the main chain is the session.
	IsSidechain bool `json:"isSidechain"`
	// The user record Claude writes after a compact_boundary, carrying its own summary.
	IsCompactSummary bool `json:"isCompactSummary"`
	Message          *struct {
		Content interface{} `json:"content"`
	} `json:"message"`
}

// parseImportTranscript reads one Claude transcript and converts it into the run events Orbit
// stores, in transcript order. It returns the recorded cwd, the title Claude gave the session
// ("" if it never did) and the event list. The conversion is refused — with a sentence the CLI
// and the failed-session record both show — when the file holds no real conversation or when
// replaying the events through replayMessagesFromEvents would not reproduce the transcript.
func parseImportTranscript(path string) (cwd, title string, events []StoredEvent, err error) {
	f, err := os.Open(path)
	if err != nil {
		return "", "", nil, err
	}
	defer f.Close()

	var (
		out     []StoredEvent
		direct  []replayMessage // what the transcript says, with the forward function's normalizations
		called  = map[string]bool{}
		pending []string
		lastTs  time.Time
	)

	// The direct side mirrors replayMessagesFromEvents' open-tool flush, so the round-trip
	// check passes for a transcript that ended mid-tool: both sides synthesize the same
	// "no result recorded" answer. Events describe what happened and never invent results.
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
		direct = append(direct, newReplayMessage("user", blocks, ts))
	}
	ev := func(typ string, payload map[string]interface{}) {
		out = append(out, StoredEvent{Seq: len(out) + 1, Type: typ, Payload: payload, Ts: lastTs})
	}

	r := bufio.NewReaderSize(f, transcriptReadBuffer)
	for {
		line, readErr := r.ReadString('\n')
		if strings.TrimSpace(line) != "" {
			var rec importRecord
			if json.Unmarshal([]byte(line), &rec) != nil {
				return "", "", nil, fmt.Errorf("transcript %s holds a line that is not JSON", path)
			}
			if rec.IsSidechain {
				continue
			}
			if rec.Cwd != "" && cwd == "" {
				cwd = rec.Cwd
			}
			if rec.Type == "ai-title" && strings.TrimSpace(rec.AiTitle) != "" {
				title = rec.AiTitle
			}
			if ts, perr := time.Parse(time.RFC3339Nano, rec.Timestamp); perr == nil {
				lastTs = ts
			}
			// Bookkeeping rows (summary, ai-title, …) carry no message; their blocks are nil.
			// Claude writes a single-text content as a bare string ("为什么页面打不开"), not a
			// blocks array — normalize to the block shape the cases below share.
			var blocks []interface{}
			if rec.Message != nil {
				switch c := rec.Message.Content.(type) {
				case string:
					blocks = []interface{}{map[string]interface{}{"type": "text", "text": c}}
				case []interface{}:
					blocks = c
				}
			}
			switch rec.Type {
			case "user":
				if rec.IsCompactSummary {
					// The forward function reads the summary from a system event and turns it
					// into storedSummary, not a message; the direct side skips it the same way.
					flushPending(lastTs)
					ev(evSystem, map[string]interface{}{"subtype": "compact_summary", "text": compactSummaryText(rec.Message.Content)})
					continue
				}
				for _, b := range blocks {
					m, _ := b.(map[string]interface{})
					switch m["type"] {
					case "text":
						text := asString(m["text"])
						if strings.TrimSpace(text) == "" {
							continue
						}
						flushPending(lastTs)
						ev(evUser, map[string]interface{}{"text": text})
						direct = append(direct, newReplayMessage("user",
							[]map[string]interface{}{{"type": "text", "text": text}}, lastTs))
					case "tool_result":
						id := asString(m["tool_use_id"])
						if id == "" || !called[id] {
							continue // orphan: replaying it would error, so neither side keeps it
						}
						pending = removeString(pending, id)
						isErr, _ := m["is_error"].(bool)
						ev(evToolResult, map[string]interface{}{
							"toolUseId": id,
							"content":   m["content"],
							"isError":   isErr,
						})
						direct = append(direct, newReplayMessage("user", []map[string]interface{}{{
							"type":        "tool_result",
							"tool_use_id": id,
							"content":     clip(toolResultText(m["content"]), transcriptToolResultMaxRunes),
							"is_error":    isErr,
						}}, lastTs))
					}
				}
			case "assistant":
				for _, b := range blocks {
					m, _ := b.(map[string]interface{})
					switch m["type"] {
					case "text":
						text := asString(m["text"])
						if strings.TrimSpace(text) == "" {
							continue
						}
						// The forward function flushes open tool calls before every assistant
						// message, so a tool_use followed by prose in the same row closes the
						// call on both sides.
						flushPending(lastTs)
						ev(evAssistant, map[string]interface{}{"text": text})
						direct = append(direct, newReplayMessage("assistant",
							[]map[string]interface{}{{"type": "text", "text": text}}, lastTs))
					case "tool_use":
						id := asString(m["id"])
						if id == "" {
							continue // unaddressable: no result could ever be matched to it
						}
						name := asString(m["name"])
						if name == "" {
							name = "tool"
						}
						input := m["input"]
						if input == nil {
							input = map[string]interface{}{}
						}
						called[id] = true
						pending = append(pending, id)
						ev(evToolUse, map[string]interface{}{"id": id, "name": name, "input": input})
						direct = append(direct, newReplayMessage("assistant", []map[string]interface{}{
							{"type": "tool_use", "id": id, "name": name, "input": input},
						}, lastTs))
					}
					// thinking blocks: dropped by the forward function, so dropped here too.
				}
			}
		}
		if readErr != nil {
			break
		}
	}
	if len(direct) > 0 {
		flushPending(direct[len(direct)-1].ts)
	}
	// The forward function trims to the first real user turn; mirror that before comparing.
	for i, m := range direct {
		if isUserTurnStart(m) {
			direct = direct[i:]
			break
		}
	}
	hasConversation := false
	for _, e := range out {
		if e.Type == evUser {
			hasConversation = true
			break
		}
	}
	if !hasConversation {
		return "", "", nil, fmt.Errorf("transcript %s holds no conversation (no user messages)", path)
	}
	replayed, _, _ := replayMessagesFromEvents(out)
	if len(replayed) != len(direct) {
		return "", "", nil, fmt.Errorf("transcript replay self-check failed: %d messages replayed, %d read", len(replayed), len(direct))
	}
	for i := range replayed {
		if replayed[i].role != direct[i].role || !reflect.DeepEqual(replayed[i].blocks, direct[i].blocks) {
			return "", "", nil, fmt.Errorf("transcript replay self-check failed at message %d (%s)", i+1, replayed[i].role)
		}
	}
	return cwd, title, out, nil
}

// compactSummaryText extracts the summary prose from an isCompactSummary user record. Claude
// writes it as text content blocks; the rebuilt-transcript form uses a bare content string.
func compactSummaryText(content interface{}) string {
	switch c := content.(type) {
	case string:
		return c
	case []interface{}:
		var b strings.Builder
		for _, it := range c {
			if m, ok := it.(map[string]interface{}); ok && m["type"] == "text" {
				b.WriteString(asString(m["text"]))
			}
		}
		return strings.TrimSpace(b.String())
	}
	return ""
}

// findClaudeTranscripts is the glob-all sibling of findClaudeTranscript: every project
// directory holding a file for this session id. The first match is not necessarily the one we
// want — a previous import may have left a copy under a dead checkout — so the import step
// tries candidates until one passes the workspace check.
func findClaudeTranscripts(sessionUUID string) []string {
	base := os.Getenv("CLAUDE_CONFIG_DIR")
	if base == "" {
		home, err := os.UserHomeDir()
		if err != nil || home == "" {
			return nil
		}
		base = filepath.Join(home, ".claude")
	}
	matches, _ := filepath.Glob(filepath.Join(base, "projects", "*", sessionUUID+".jsonl"))
	return matches
}

// insideDir reports whether p is dir itself or a path below it.
func insideDir(dir, p string) bool {
	d := filepath.Clean(dir)
	c := filepath.Clean(p)
	return c == d || strings.HasPrefix(c, d+string(filepath.Separator))
}

// copyTranscriptRewritingCwd copies the transcript into the session's own project directory,
// rewriting each record's recorded cwd to the session checkout, so `--resume` (which reads
// only the directory for the engine's own cwd) finds the conversation. Lines that fail to
// parse are copied verbatim — the import already refused unreadable transcripts, and a
// bookkeeping record we don't understand is not ours to edit.
func copyTranscriptRewritingCwd(src, dst, newCwd string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	r := bufio.NewReaderSize(in, transcriptReadBuffer)
	var b bytes.Buffer
	for {
		line, readErr := r.ReadString('\n')
		if strings.TrimSpace(line) != "" {
			rewritten := false
			var rec map[string]interface{}
			if json.Unmarshal([]byte(line), &rec) == nil {
				if _, has := rec["cwd"]; has {
					rec["cwd"] = newCwd
					if out, merr := json.Marshal(rec); merr == nil {
						b.Write(out)
						b.WriteByte('\n')
						rewritten = true
					}
				}
			}
			if !rewritten {
				b.WriteString(line)
			}
		}
		if readErr != nil {
			break
		}
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	return writeFileAtomically(dst, b.Bytes(), 0o644)
}

// runTranscriptImport is the import step a claim runs once, after the inbox generation is
// activated and before the engine spawns: locate the transcript, verify it belongs to this
// workspace, place a copy where --resume will read it, replay it as run events and settle the
// importSourceCwd marker with the control plane. On any refusal it settles the marker as
// FAILED (the session ends in Trash with the reason) and returns the error, which the
// supervisor turns into a stopped run — an import never leaves a half-created session behind.
//
// Events are flushed before the ok POST, so a crash after the settlement can never strand a
// marker-less session with an empty transcript: the events are already durable, and a reclaim
// skips the stored prefix via job.MaxSeq.
func runTranscriptImport(ctx context.Context, t *Transport, job *ClaimedSession, execDir string, emit emitFn, flush func(context.Context) error) error {
	fail := func(err error) error {
		// Best effort: the lease fence may already refuse us, and the error it carries is the
		// session's record either way.
		if _, postErr := t.importResult(job.SessionID, ImportResultRequest{Ok: false, Error: err.Error()}); postErr != nil {
			logln("import-result (failed) post failed for", job.SessionID+":", postErr)
		}
		return err
	}
	src := ""
	if p, err := claudeTranscriptPath(*job.ImportSourceCwd, job.SessionUUID); err == nil && isRegularFile(p) {
		src = p
	}
	candidates := findClaudeTranscripts(job.SessionUUID)
	if src == "" && len(candidates) > 0 {
		src = candidates[0]
	}
	if src == "" {
		return fail(fmt.Errorf("no transcript found for Claude session %s on this machine", job.SessionUUID))
	}
	// A previous import can leave a copy under a dead checkout; try candidates until one
	// parses and belongs to this workspace, and report the last refusal when none does.
	var lastErr error
	seen := map[string]bool{}
	// The workspace workDir arrives from the claim exactly as the user typed it, so most of them
	// are home-relative (`~/orbit`) while a transcript always records an absolute cwd. Expanded
	// here, once, the way every other consumer of a workDir on this machine already does it.
	workDir := expandTilde(job.WorkDir)
	for _, cand := range append([]string{src}, candidates...) {
		if seen[cand] {
			continue
		}
		seen[cand] = true
		cwd, title, events, err := parseImportTranscript(cand)
		if err != nil {
			lastErr = err
			continue
		}
		if !insideDir(workDir, cwd) {
			lastErr = fmt.Errorf("the transcript was recorded in %s, outside the workspace %s", cwd, workDir)
			continue
		}
		dst, derr := claudeTranscriptPath(execDir, job.SessionUUID)
		if derr != nil {
			return fail(fmt.Errorf("cannot place the transcript for the session: %v", derr))
		}
		if err := copyTranscriptRewritingCwd(cand, dst, execDir); err != nil {
			return fail(fmt.Errorf("cannot place the transcript for the session: %v", err))
		}
		// The emit closure's seq continues from job.MaxSeq, so skipping the already-stored
		// prefix keeps (sessionId, seq) unique across a mid-import reclaim.
		for i := job.MaxSeq; i < len(events); i++ {
			emit(events[i].Type, events[i].Payload)
		}
		if err := flush(ctx); err != nil {
			return fail(fmt.Errorf("cannot store the replayed transcript: %v", err))
		}
		resp, err := t.importResult(job.SessionID, ImportResultRequest{Ok: true, Title: title})
		if err != nil {
			return fail(fmt.Errorf("cannot settle the import: %v", err))
		}
		if !resp.Ok {
			return fail(fmt.Errorf("the control plane refused the import result"))
		}
		// The marker is settled: a respawn iteration of this same supervision loop must not
		// re-import (the events are already stored and the seq cursor has moved past them).
		job.ImportSourceCwd = nil
		return nil
	}
	return fail(lastErr)
}

func isRegularFile(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.Mode().IsRegular()
}
