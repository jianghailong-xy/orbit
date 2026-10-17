//go:build linux || darwin

package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// The transcript order a whole Kimi turn lands under, driven through the real supervisor and a
// scripted `kimi acp` (fake_kimi_acp_test.go): reasoning, then reply text, then a tool call and
// its result, then more reasoning and the final reply. Kimi used to buffer the turn whole and
// persist one thinking block and one reply at its end — every thought after every tool call and
// answer, whatever the true order was, which is what read as a jumbled transcript. The verdict
// is read off what the control plane was sent: the durable events must follow the stream.
func TestKimiTurnEventsReachTheControlPlaneInStreamOrder(t *testing.T) {
	chunk := func(kind, text string) map[string]interface{} {
		return map[string]interface{}{
			"sessionUpdate": kind,
			"content":       map[string]interface{}{"type": "text", "text": text},
		}
	}
	fake := newFakeKimiEngine(t,
		chunk("agent_thought_chunk", "plan first"),
		map[string]interface{}{"sleepMs": 80},
		chunk("agent_message_chunk", "I'll read it."),
		map[string]interface{}{
			"sessionUpdate": "tool_call", "toolCallId": "1:t", "title": "Read",
			"rawInput": map[string]interface{}{"path": "a.txt"},
		},
		map[string]interface{}{
			"sessionUpdate": "tool_call_update", "toolCallId": "1:t",
			"status": "completed", "rawOutput": "x",
		},
		chunk("agent_thought_chunk", "now decide"),
		chunk("agent_message_chunk", "Done."),
	)
	t.Setenv("PATH", fake.Dir+string(os.PathListSeparator)+os.Getenv("PATH"))

	home, err := os.MkdirTemp("", "ors")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(home) })
	t.Setenv("ORBIT_HOME", home)
	job := &ClaimedSession{
		SessionID:   "sess-kimi-stream-order",
		SessionUUID: "11111111-2222-3333-4444-555555555556",
		Title:       "check the transcript order",
		Provider:    providerKimi,
		Agent: AgentExecConfig{
			Provider: providerKimi,
			Env: map[string]string{
				"KIMI_CODE_HOME":     filepath.Join(t.TempDir(), ".kimi-code"),
				// An environment-backed provider is the session's own credential, so the
				// auth preflight never asks this machine's login about the fake CLI.
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

	// The durable record, deltas and handshake noise aside: each stretch closed where the
	// stream moved past it, not in one heap at the turn's end.
	var order []string
	texts := map[int]string{}
	var thinkingMs []int64
	for _, e := range api.deliveredEvents() {
		switch e.Type {
		case evUser, evThinking, evAssistant, evToolUse, evToolResult, evTurnEnd:
			order = append(order, e.Type)
			if text, ok := e.Payload["text"].(string); ok {
				texts[len(order)-1] = text
			}
			if e.Type == evThinking {
				ms, _ := e.Payload["thinkingMs"].(float64)
				thinkingMs = append(thinkingMs, int64(ms))
			}
		}
	}
	want := []string{
		evUser, evThinking, evAssistant, evToolUse, evToolResult, evThinking, evAssistant, evTurnEnd,
	}
	if len(order) != len(want) {
		t.Fatalf("durable event order = %v, want %v (all events: %#v)", order, want, api.deliveredEvents())
	}
	for i, w := range want {
		if order[i] != w {
			t.Fatalf("durable event order = %v, want %v", order, want)
		}
	}
	if texts[1] != "plan first" || texts[2] != "I'll read it." ||
		texts[5] != "now decide" || texts[6] != "Done." {
		t.Fatalf("stretch texts out of order: %#v", texts)
	}
	// Each block carries its own stretch's time: the first held an 80ms beat of reasoning and
	// says so; the second, streamed in a burst, claims none of it back.
	if len(thinkingMs) != 2 || thinkingMs[0] < 60 {
		t.Fatalf("thinkingMs per block = %v, want the first to time its 80ms stretch", thinkingMs)
	}
	if thinkingMs[1] >= thinkingMs[0] {
		t.Fatalf("thinkingMs per block = %v: the burst stretch inherited the timed one", thinkingMs)
	}
}
