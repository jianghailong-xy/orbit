//go:build linux || darwin

package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// The records Kimi 2.5.3 wrote for the turn it failed on 2026-11-12 (session 34tldRMFzXMU1CBLQ1GFZ),
// trimmed to what is read: an automatic compaction began as the turn opened, its summary came back,
// a tool-update reminder had landed in the history meanwhile, so Kimi cancelled the compaction, and
// the turn waiting on it failed as `internal: [object Object]` without its model ever being asked.
var kimiDroppedCompactionTurn = []map[string]interface{}{
	{"type": "turn.prompt", "agentId": "main", "turnId": 111},
	{"type": "full_compaction.begin", "source": "auto", "agentId": "main"},
	{"type": "llm.request", "agentId": "main", "kind": "compaction"},
	{"type": "full_compaction.cancel", "agentId": "main"},
	{"type": "turn.step.interrupted", "agentId": "main", "turnId": 111, "step": 1, "reason": "error"},
	{"type": "turn.ended", "agentId": "main", "turnId": 111, "reason": "failed",
		"error": map[string]interface{}{"code": "internal", "message": "[object Object]", "retryable": false}},
}

func TestKimiTurnFailedByADroppedCompactionIsToldApart(t *testing.T) {
	home := t.TempDir()
	write := func(records []map[string]interface{}) (string, int64) {
		t.Helper()
		writeFakeKimiACPWire(home, []map[string]interface{}{})
		wire, from := kimiTurnWire(home, fakeKimiACPSession)
		if wire == "" {
			t.Fatal("no wire for the fake session")
		}
		writeFakeKimiACPWire(home, records)
		return wire, from
	}
	ctx := context.Background()

	wire, from := write(kimiDroppedCompactionTurn)
	want := kimiTurnOutcome{read: true, ran: true, compactionDropped: true,
		failure: "Kimi Code failed this turn (internal): [object Object]"}
	if got := readKimiTurnOutcome(ctx, wire, from, nil); got != want {
		t.Fatalf("the dropped compaction's turn = %+v, want %+v", got, want)
	}

	// The compaction was dropped, but the turn's model ran after it and the turn failed on that: not
	// a turn that never ran.
	ranAfter := append([]map[string]interface{}{}, kimiDroppedCompactionTurn[:4]...)
	ranAfter = append(ranAfter, map[string]interface{}{"type": "llm.request", "agentId": "main", "kind": "loop"},
		kimiDroppedCompactionTurn[5])
	wire, from = write(ranAfter)
	if got := readKimiTurnOutcome(ctx, wire, from, nil); got.compactionDropped || got.failure == "" {
		t.Fatalf("a turn whose model ran after the cancel = %+v", got)
	}

	// A compaction a sub-agent cancelled is not the main agent's.
	other := append([]map[string]interface{}{}, kimiDroppedCompactionTurn...)
	other[3] = map[string]interface{}{"type": "full_compaction.cancel", "agentId": "sub-1"}
	wire, from = write(other)
	if got := readKimiTurnOutcome(ctx, wire, from, nil); got.compactionDropped {
		t.Fatalf("a sub-agent's cancel = %+v", got)
	}

	// A turn that ended well after a dropped compaction is just a turn that ended well.
	fine := append([]map[string]interface{}{}, kimiDroppedCompactionTurn[:5]...)
	fine = append(fine, map[string]interface{}{"type": "turn.ended", "agentId": "main", "turnId": 111, "reason": "completed"})
	wire, from = write(fine)
	if got := readKimiTurnOutcome(ctx, wire, from, nil); got != (kimiTurnOutcome{read: true, ran: true}) {
		t.Fatalf("a completed turn after a cancel = %+v", got)
	}
}

// Through the real supervisor and a scripted `kimi acp`: the prompt whose turn failed only by the
// dropped compaction is sent once more, and the second attempt's end is the Orbit turn's. A second
// drop in a row is reported as the failure it is — no more than one re-send.
func TestKimiTurnFailedByADroppedCompactionIsSentOnceMore(t *testing.T) {
	completed := []map[string]interface{}{
		{"type": "turn.prompt", "agentId": "main", "turnId": 112},
		{"type": "llm.request", "agentId": "main", "kind": "loop"},
		{"type": "turn.ended", "agentId": "main", "turnId": 112, "reason": "completed"},
	}
	for _, tc := range []struct {
		name    string
		wires   [][]map[string]interface{}
		prompts string
		status  string
	}{
		{"recovers", [][]map[string]interface{}{kimiDroppedCompactionTurn, completed}, "2", stSucceeded},
		{"drops twice", [][]map[string]interface{}{kimiDroppedCompactionTurn}, "2", stFailed},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fake := newFakeKimiEngine(t, map[string]interface{}{
				"sessionUpdate": "agent_message_chunk",
				"content":       map[string]interface{}{"type": "text", "text": "ok"},
			}).withWires(tc.wires...)
			t.Setenv("PATH", fake.Dir+string(os.PathListSeparator)+os.Getenv("PATH"))
			home, err := os.MkdirTemp("", "ors")
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = os.RemoveAll(home) })
			t.Setenv("ORBIT_HOME", home)
			job := &ClaimedSession{
				SessionID:   "sess-kimi-dropped-compaction",
				SessionUUID: "11111111-2222-3333-4444-555555555557",
				Title:       "a turn behind a dropped compaction",
				Provider:    providerKimi,
				Agent: AgentExecConfig{
					Provider: providerKimi,
					Env: map[string]string{
						"KIMI_CODE_HOME":     filepath.Join(t.TempDir(), ".kimi-code"),
						"KIMI_MODEL_NAME":    "test-model",
						"KIMI_MODEL_API_KEY": "test-key",
					},
				},
			}
			api := newRunnerStopControlPlane()
			api.queue(RunInboxResponse{TurnID: "turn-1", Kind: "message", Content: "go"})
			superviseUntilRunnerStop(t, job, true, api)
			awaitCondition(t, 30*time.Second, "turn-1 was never answered", func() bool {
				return api.settled("turn-1")
			})
			if got := fake.prompts(); got != tc.prompts {
				t.Fatalf("prompts sent = %s, want %s", got, tc.prompts)
			}
			var done []TurnCompleteRequest
			for _, c := range api.turnCompletions() {
				if c.TurnID == "turn-1" {
					done = append(done, c)
				}
			}
			if len(done) != 1 || done[0].Status != tc.status {
				t.Fatalf("turn-1 completions = %+v, want one %s", done, tc.status)
			}
		})
	}
}
