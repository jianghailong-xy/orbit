package main

import (
	"encoding/json"
	"strings"
	"testing"
)

// A main checkout result line queued as a `notice` turn (main_checkout_notice.go), through the real session loop
// against the fake CLI: written as a session-level system event under the runner's own numbering, never shown to the
// engine, never settled as a turn — and the agent's events around it keep seqs of their own.

func noticeTurn(id string, payload map[string]interface{}) scriptedTurn {
	content, err := json.Marshal(payload)
	if err != nil {
		panic(err)
	}
	return scriptedTurn{turn: RunInboxResponse{TurnID: id, Kind: mainCheckoutNoticeKind, Content: string(content)}, ungated: true}
}

const committedLine = "Committed 3 files to main in the main checkout as 8d41e0c “Add retry backoff”. Not pushed yet. This session's branch is unchanged."

func committedNotice() map[string]interface{} {
	return map[string]interface{}{
		"noticeKind": "main-checkout-action-result",
		"notice":     committedLine,
		"result": map[string]interface{}{
			"requestId": "req-1", "kind": "commit", "root": "/repo", "status": "done", "branch": "main",
			"fileCount": 3, "head": "8d41e0c0000000000000000000000000000000000", "subject": "Add retry backoff",
			"finishedAt": "2026-11-12T00:00:00Z",
		},
	}
}

func TestMainCheckoutNoticeIsWrittenUnderTheRunnersOwnSeqMidTurn(t *testing.T) {
	// The claim's high-water mark: the control plane holds seqs 1..40, so this process numbers from 41.
	numbered := &sessionEventBuffer{next: 41, clock: &thinkingClock{}}
	notice := noticeTurn("notice-1", committedNotice())
	notice.afterEngineRead = "turn-1" // lands while the agent's turn is running
	run := runDeliverySessionWith(t,
		[]fakeStep{
			{Await: "user"},
			{Emit: "replay_user"},
			{Emit: "assistant", Text: "working on it"},
			{Emit: "result", Text: "done"},
			{Await: "user"},
			{Emit: "replay_user"},
			{Emit: "assistant", Text: "and the next one"},
			{Emit: "result", Text: "done again"},
			{Emit: "eof"},
		},
		[]scriptedTurn{
			messageTurn("turn-1", "start something"),
			notice,
			messageTurn("turn-2", "now this"),
		}, nil, deliveryOptions{numbered: numbered})

	events := numbered.take()
	seen := map[int]bool{}
	var line *RunEvent
	for i, e := range events {
		if seen[e.Seq] {
			t.Fatalf("seq %d was taken twice: %+v", e.Seq, events)
		}
		seen[e.Seq] = true
		if i > 0 && e.Seq != events[i-1].Seq+1 {
			t.Fatalf("seqs are not one run after the claim's mark: %d after %d", e.Seq, events[i-1].Seq)
		}
		if e.Type == evSystem && e.Payload["noticeKind"] == "main-checkout-action-result" {
			if line != nil {
				t.Fatal("the notice was written twice")
			}
			ev := events[i]
			line = &ev
		}
	}
	if len(events) == 0 || events[0].Seq != 41 {
		t.Fatalf("the session's first event took seq %v, want 41 (MaxSeq 40 + 1)", events)
	}
	if line == nil {
		t.Fatalf("no main checkout line among the session's events: %+v", events)
	}
	if line.TurnID != "" {
		t.Errorf("the line was filed under turn %q; it is a session-level event", line.TurnID)
	}
	if line.Payload["notice"] != committedLine {
		t.Errorf("the line reads %q, want the control plane's text", line.Payload["notice"])
	}
	if result, _ := line.Payload["result"].(map[string]interface{}); result == nil || result["requestId"] != "req-1" {
		t.Errorf("the line's result did not come through: %v", line.Payload["result"])
	}
	// Agent events after it are numbered after it: nothing the agent says next can land on its seq.
	after := 0
	for _, e := range events {
		if e.Seq > line.Seq && e.TurnID == "turn-2" {
			after++
		}
	}
	if after == 0 {
		t.Errorf("no event of the next turn was numbered after the line (seq %d): %+v", line.Seq, events)
	}
	// Never the agent's: the CLI read no frame carrying it, and no turn completion names it.
	for _, frame := range run.fake.Stdin() {
		raw, _ := json.Marshal(frame)
		if strings.Contains(string(raw), "Add retry backoff") {
			t.Fatalf("the engine was handed the notice: %s", raw)
		}
	}
	if got := run.turnResult("notice-1"); got != nil {
		t.Errorf("the notice was settled as a turn: %+v", got)
	}
	for _, id := range []string{"turn-1", "turn-2"} {
		if got := run.turnResult(id); got == nil || got.Status != stSucceeded {
			t.Errorf("%s settled as %v, want %s", id, got, stSucceeded)
		}
	}
}

func TestMainCheckoutNoticeThatIsNotAnObjectIsDropped(t *testing.T) {
	var got []map[string]interface{}
	defer registerMainCheckoutNotices("11111111-1111-4111-8111-111111111111", func(_, _ string, p map[string]interface{}) {
		got = append(got, p)
	})()
	if !takeMainCheckoutNotice("11111111-1111-4111-8111-111111111111", &RunInboxResponse{TurnID: "n", Kind: "notice", Content: "[1]"}) {
		t.Fatal("a notice turn was not taken")
	}
	if takeMainCheckoutNotice("11111111-1111-4111-8111-111111111111", &RunInboxResponse{TurnID: "m", Kind: "message", Content: "{}"}) {
		t.Fatal("a message turn was taken as a notice")
	}
	if len(got) != 0 {
		t.Fatalf("a malformed notice was written: %v", got)
	}
}
