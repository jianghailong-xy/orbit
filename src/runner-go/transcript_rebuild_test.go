package main

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func ev(seq int, typ string, payload map[string]interface{}) StoredEvent {
	return StoredEvent{Seq: seq, Type: typ, Payload: payload, Ts: time.Unix(int64(1700000000+seq), 0).UTC()}
}

// `--resume` reads only the project directory for the process's own cwd, so this escaping is
// load-bearing: get it wrong and the rebuilt file lands somewhere claude never looks. Verified
// against the CLI — every character outside [A-Za-z0-9] becomes '-', runs are NOT collapsed.
func TestClaudeProjectSlug(t *testing.T) {
	cases := map[string]string{
		"/root/.orbit/worktrees/019fc789-9751": "-root--orbit-worktrees-019fc789-9751",
		"/tmp/slug_a.b c-d+e@f":                "-tmp-slug-a-b-c-d-e-f",
		"/root":                                "-root",
	}
	for in, want := range cases {
		if got := claudeProjectSlug(in); got != want {
			t.Fatalf("slug(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestReplayMessagesFromEvents(t *testing.T) {
	msgs, _, _ := replayMessagesFromEvents([]StoredEvent{
		// Leading assistant chatter has no user turn to answer — the replay must open on a user.
		ev(1, evAssistant, map[string]interface{}{"text": "orphan opener"}),
		ev(2, evUser, map[string]interface{}{"text": "list the files"}),
		// Thinking is dropped: Orbit has the text but not its signature.
		ev(3, evThinking, map[string]interface{}{"text": "let me think"}),
		ev(4, evToolUse, map[string]interface{}{"id": "t1", "name": "Bash", "input": map[string]interface{}{"command": "ls"}}),
		ev(5, evToolResult, map[string]interface{}{"toolUseId": "t1", "content": "a.txt"}),
		// A result whose call never reached the log would make the API reject the replay.
		ev(6, evToolResult, map[string]interface{}{"toolUseId": "ghost", "content": "?"}),
		ev(7, evAssistant, map[string]interface{}{"text": "just a.txt"}),
		// Killed mid-tool: this call never got its result.
		ev(8, evToolUse, map[string]interface{}{"id": "t2", "name": "", "input": nil}),
	})

	var got []string
	for _, m := range msgs {
		for _, b := range m.blocks {
			got = append(got, m.role+"/"+b["type"].(string))
		}
	}
	want := []string{
		"user/text",          // opens on the user turn; the leading assistant text is gone
		"assistant/tool_use", // thinking dropped
		"user/tool_result",
		"assistant/text", // the ghost result was skipped
		"assistant/tool_use",
		"user/tool_result", // synthesized so t2 isn't left unanswered
	}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("blocks = %v, want %v", got, want)
	}
	// An unnamed call (Codex records some) still needs a name the API will accept.
	if name := msgs[4].blocks[0]["name"]; name != "tool" {
		t.Fatalf("unnamed tool_use name = %v, want \"tool\"", name)
	}
	last := msgs[5].blocks[0]
	if last["tool_use_id"] != "t2" || last["is_error"] != true {
		t.Fatalf("synthetic result = %v, want an error result for t2", last)
	}
}

// A log that opens mid-tool-call (the tail of an older run) must not start the replay on the
// tool_result: splitForReplay snaps budget cuts forward to a user turn and would have nowhere to
// land, and the API rejects a conversation that doesn't open on a user message.
func TestReplayOpensOnAUserTurn(t *testing.T) {
	msgs, _, _ := replayMessagesFromEvents([]StoredEvent{
		ev(1, evToolUse, map[string]interface{}{"id": "t1", "name": "Bash", "input": map[string]interface{}{}}),
		ev(2, evToolResult, map[string]interface{}{"toolUseId": "t1", "content": "done"}),
		ev(3, evUser, map[string]interface{}{"text": "carry on"}),
		ev(4, evAssistant, map[string]interface{}{"text": "ok"}),
	})
	if len(msgs) != 2 || !isUserTurnStart(msgs[0]) {
		t.Fatalf("replay must open on the user turn, got %d messages starting %v", len(msgs), msgs[0].blocks)
	}
	// Nothing replayable at all is a rebuild that must not happen, not an empty transcript.
	if got, _, _ := replayMessagesFromEvents([]StoredEvent{
		ev(1, evAssistant, map[string]interface{}{"text": "orphaned"}),
	}); got != nil {
		t.Fatalf("history with no user turn = %v, want nil", got)
	}
}

func TestSplitForReplaySnapsToUserTurn(t *testing.T) {
	mk := func(role, typ, text string) replayMessage {
		return newReplayMessage(role, []map[string]interface{}{{"type": typ, "text": text}}, time.Unix(0, 0))
	}
	big := strings.Repeat("x", 3000) // ~1000 estimated tokens
	msgs := []replayMessage{
		mk("user", "text", big),
		mk("assistant", "text", big),
		mk("user", "text", "second turn"),
		mk("assistant", "tool_use", "call"),
		mk("user", "tool_result", "result"),
	}
	// A budget that reaches back into the middle of turn two must snap forward to its start,
	// never leave the replay opening on the tool_result at index 4.
	if got := splitForReplay(msgs, 1200); got != 2 {
		t.Fatalf("cut = %d, want 2 (start of the second user turn)", got)
	}
	// Everything fits → no compaction.
	if got := splitForReplay(msgs, 100000); got != 0 {
		t.Fatalf("cut = %d, want 0 when the history fits", got)
	}
}

// Claude's own compaction summary is the cheapest possible stand-in for the history it replaced:
// no summarizer call, and it is the same text the live session was actually running on.
func TestStoredCompactSummaryIsReusedAndPositioned(t *testing.T) {
	msgs, summary, cut := replayMessagesFromEvents([]StoredEvent{
		// Dropped by the open-on-a-user-turn trim, which also has to shift `cut` back by one.
		ev(1, evAssistant, map[string]interface{}{"text": "leftover"}),
		ev(2, evUser, map[string]interface{}{"text": "old work"}),
		ev(3, evAssistant, map[string]interface{}{"text": "done"}),
		ev(4, evSystem, map[string]interface{}{"subtype": "compact_boundary"}),
		ev(5, evSystem, map[string]interface{}{"subtype": "compact_summary", "text": "claude's own summary"}),
		ev(6, evUser, map[string]interface{}{"text": "keep going"}),
	})
	if summary != "claude's own summary" {
		t.Fatalf("stored summary = %q", summary)
	}
	if cut != 2 {
		t.Fatalf("cut = %d, want 2 (the two pre-boundary messages after the trim)", cut)
	}
	// It is preferred over paying to write a new one: the summarizer must not be reached.
	gotCut, gotSummary := planReplay(msgs, summary, cut, func([]replayMessage) string {
		t.Fatal("a stored summary must not trigger a summarizer call")
		return ""
	})
	if gotCut != 2 || gotSummary != "claude's own summary" {
		t.Fatalf("planReplay = (%d, %q), want (2, claude's own summary)", gotCut, gotSummary)
	}
	// A later compaction supersedes an earlier one.
	_, latest, _ := replayMessagesFromEvents([]StoredEvent{
		ev(1, evUser, map[string]interface{}{"text": "start"}),
		ev(2, evSystem, map[string]interface{}{"subtype": "compact_summary", "text": "first"}),
		ev(3, evUser, map[string]interface{}{"text": "more"}),
		ev(4, evSystem, map[string]interface{}{"subtype": "compact_summary", "text": "second"}),
	})
	if latest != "second" {
		t.Fatalf("latest stored summary = %q, want \"second\"", latest)
	}
}

// A stored summary only helps if what came AFTER it still fits; otherwise the budget has to pick
// the split itself, and reusing the stale boundary would replay straight past the window.
func TestOversizedTailFallsBackToBudgetSplit(t *testing.T) {
	mk := func(role, typ, text string) replayMessage {
		return newReplayMessage(role, []map[string]interface{}{{"type": typ, "text": text}}, time.Unix(0, 0))
	}
	huge := strings.Repeat("y", transcriptReplayTokenBudget*4) // comfortably over budget
	msgs := []replayMessage{
		mk("user", "text", "before the compaction"),
		mk("user", "text", huge),
		mk("user", "text", "the newest turn"),
	}
	cut, summary := planReplay(msgs, "stale summary", 1, func([]replayMessage) string { return "freshly written" })
	if cut == 1 || summary == "stale summary" {
		t.Fatalf("an over-budget tail must not reuse the stored boundary, got (%d, %q)", cut, summary)
	}
	if cut != 2 {
		t.Fatalf("cut = %d, want 2 (the only turn that fits)", cut)
	}
}

// Claude's summary already opens with its own explanation; only one we wrote needs introducing.
func TestSummaryPreambleIsNotDoubled(t *testing.T) {
	own := compactSummaryMarker + " that ran out of context.\n\nSummary:\nstuff"
	if got := withCompactPreamble(own); got != own {
		t.Fatalf("claude's own summary was rewritten:\n%s", got)
	}
	ours := withCompactPreamble("we wrote this")
	if !strings.HasPrefix(ours, rebuiltSummaryPreamble) || strings.Count(ours, "Summary:") != 1 {
		t.Fatalf("generated summary preamble is wrong:\n%s", ours)
	}
}

// The compact boundary is what keeps a rebuilt long session inside the context window: the
// pre-boundary records stay in the file for the transcript UI, but parentUuid: null cuts the
// chain the CLI walks back from the tail, so only the summary and what follows reach the model.
func TestRenderTranscriptJSONLCompactBoundary(t *testing.T) {
	job := &ClaimedSession{SessionUUID: "11111111-2222-4333-8444-555555555555", Branch: "feat/x"}
	job.Agent.Model = "claude-opus-4-5"
	mk := func(role, text string) replayMessage {
		return newReplayMessage(role, []map[string]interface{}{{"type": "text", "text": text}}, time.Unix(1700000000, 0))
	}
	msgs := []replayMessage{mk("user", "old"), mk("assistant", "older reply"), mk("user", "recent")}

	data, err := renderTranscriptJSONL(msgs, 2, "the summary", job, "/work")
	if err != nil {
		t.Fatal(err)
	}
	var recs []map[string]interface{}
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		var r map[string]interface{}
		if err := json.Unmarshal([]byte(line), &r); err != nil {
			t.Fatal(err)
		}
		recs = append(recs, r)
	}
	if len(recs) != 5 {
		t.Fatalf("records = %d, want 5 (2 head + boundary + summary + 1 tail)", len(recs))
	}
	boundary, summary, tail := recs[2], recs[3], recs[4]
	if boundary["subtype"] != "compact_boundary" || boundary["parentUuid"] != nil {
		t.Fatalf("boundary must cut the chain: %v", boundary)
	}
	if boundary["logicalParentUuid"] != recs[1]["uuid"] {
		t.Fatalf("boundary lost its lineage to the pre-compact tail")
	}
	if summary["isCompactSummary"] != true || summary["parentUuid"] != boundary["uuid"] {
		t.Fatalf("summary must hang off the boundary: %v", summary)
	}
	if !strings.Contains(summary["message"].(map[string]interface{})["content"].(string), "the summary") {
		t.Fatalf("summary text missing")
	}
	if tail["parentUuid"] != summary["uuid"] {
		t.Fatalf("replayed tail must chain from the summary, got %v", tail["parentUuid"])
	}
	// Every record still carries the identity claude expects to read back.
	for i, r := range recs {
		if r["sessionId"] != job.SessionUUID || r["cwd"] != "/work" || r["gitBranch"] != "feat/x" {
			t.Fatalf("record %d lost its session identity: %v", i, r)
		}
	}
	// Rebuilding twice must produce the same file.
	again, _ := renderTranscriptJSONL(msgs, 2, "the summary", job, "/work")
	if string(again) != string(data) {
		t.Fatalf("rebuild is not deterministic")
	}
}

// Without a summary there is no boundary at all — one unbroken chain from the first record.
func TestRenderTranscriptJSONLNoCompaction(t *testing.T) {
	job := &ClaimedSession{SessionUUID: "11111111-2222-4333-8444-555555555555"}
	msgs := []replayMessage{
		newReplayMessage("user", []map[string]interface{}{{"type": "text", "text": "hi"}}, time.Unix(0, 0)),
		newReplayMessage("assistant", []map[string]interface{}{{"type": "text", "text": "hello"}}, time.Unix(0, 0)),
	}
	data, err := renderTranscriptJSONL(msgs, 0, "", job, "/work")
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	if len(lines) != 2 {
		t.Fatalf("records = %d, want 2", len(lines))
	}
	var first, second map[string]interface{}
	_ = json.Unmarshal([]byte(lines[0]), &first)
	_ = json.Unmarshal([]byte(lines[1]), &second)
	if first["parentUuid"] != nil {
		t.Fatalf("first record must open the chain")
	}
	if second["parentUuid"] != first["uuid"] {
		t.Fatalf("chain broken")
	}
	if body := second["message"].(map[string]interface{}); body["model"] == nil || body["stop_reason"] != "end_turn" {
		t.Fatalf("assistant record is missing its message envelope: %v", body)
	}
}
