package main

// The relay's fixtures are the wires Kimi really writes: the shapes below are copied from a live
// session's agents/main/wire.jsonl and agents/agent-0/wire.jsonl (2.1.1), minus the fields the
// relay does not read.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func writeSubWire(t *testing.T, path string, records []map[string]interface{}, appendTo bool) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	writeKimiWire(t, path, records, appendTo)
}

type kimiRelayCapture struct {
	events []RunEvent
}

func (c *kimiRelayCapture) emit(eventType string, payload map[string]interface{}) {
	c.events = append(c.events, RunEvent{Type: eventType, Payload: payload})
}

func (c *kimiRelayCapture) types() []string {
	var out []string
	for _, ev := range c.events {
		out = append(out, ev.Type)
	}
	return out
}

func kimiAgentCallRecord(turnID, toolCallID, prompt string) map[string]interface{} {
	return map[string]interface{}{
		"type": "context.append_loop_event",
		"event": map[string]interface{}{
			"type": "tool.call", "turnId": turnID, "step": 6, "toolCallId": toolCallID,
			"name": "Agent", "args": map[string]interface{}{"subagent_type": "explore", "description": "Look", "prompt": prompt},
		},
	}
}

func kimiSubPromptRecord(agentID, prompt string) map[string]interface{} {
	return map[string]interface{}{
		"type": "turn.prompt", "agentId": agentID,
		"input": []interface{}{map[string]interface{}{"type": "text",
			"text": "<git-context>\nWorking directory: /repo\n</git-context>\n\n" + prompt}},
	}
}

func kimiSubToolCall(toolCallID, name string, args map[string]interface{}) map[string]interface{} {
	return map[string]interface{}{
		"type":  "context.append_loop_event",
		"event": map[string]interface{}{"type": "tool.call", "turnId": "0", "step": 1, "toolCallId": toolCallID, "name": name, "args": args},
	}
}

func kimiSubToolResult(toolCallID, output string) map[string]interface{} {
	return map[string]interface{}{
		"type":  "context.append_loop_event",
		"event": map[string]interface{}{"type": "tool.result", "toolCallId": toolCallID, "result": map[string]interface{}{"output": output, "durationMs": 5}},
	}
}

func kimiSubPart(kind, key, text string) map[string]interface{} {
	return map[string]interface{}{
		"type":  "context.append_loop_event",
		"event": map[string]interface{}{"type": "content.part", "turnId": "0", "step": 1, "part": map[string]interface{}{"type": kind, key: text}},
	}
}

func TestKimiSubRelayEndToEnd(t *testing.T) {
	dir := t.TempDir()
	cap := &kimiRelayCapture{}
	r := newKimiSubRelay(dir, filepath.Join(t.TempDir(), "state.json"), cap.emit)

	// The main agent calls Agent; the wire's record is what the relay binds on.
	writeSubWire(t, r.mainWire, []map[string]interface{}{
		kimiAgentCallRecord("0", "tool_A", "explore the repo"),
	}, false)
	r.poll()
	if len(cap.events) != 0 {
		t.Fatalf("the main wire is read for discovery only; got %v", cap.types())
	}

	writeSubWire(t, r.wirePath("agent-0"), []map[string]interface{}{
		{"type": "metadata", "protocol_version": "1.5", "created_at": 1},
		kimiSubPromptRecord("agent-0", "explore the repo"),
		kimiSubToolCall("tool_B", "Bash", map[string]interface{}{"command": "ls"}),
		kimiSubToolResult("tool_B", "file.go\n"),
		kimiSubPart("think", "think", "hmm"),
		kimiSubPart("text", "text", "found it"),
		{"type": "turn.ended", "agentId": "agent-0", "turnId": 0, "reason": "completed"},
	}, false)
	r.poll()

	got := cap.types()
	want := []string{evToolUse, evToolResult, evThinking, evAssistant}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("events = %v, want %v", got, want)
	}
	for _, ev := range cap.events {
		if ev.Payload["parentToolUseId"] != "0:tool_A" {
			t.Errorf("%s parentToolUseId = %v, want 0:tool_A (the ACP composition of the Agent call)", ev.Type, ev.Payload["parentToolUseId"])
		}
	}
	use := cap.events[0].Payload
	if use["id"] != "agent-0:tool_B" || use["name"] != "Bash" {
		t.Errorf("tool_use id/name = %v/%v, want the wire's call scoped by its agent", use["id"], use["name"])
	}
	if input := mapValue(use["input"]); input == nil || input["command"] != "ls" {
		t.Errorf("tool_use input = %v, want the call's args", use["input"])
	}
	result := cap.events[1].Payload
	if result["toolUseId"] != "agent-0:tool_B" || result["content"] != "file.go\n" || result["isError"] != false {
		t.Errorf("tool_result = %v", result)
	}
	if cap.events[2].Payload["text"] != "hmm" || cap.events[3].Payload["text"] != "found it" {
		t.Errorf("thinking/assistant text = %v/%v", cap.events[2].Payload["text"], cap.events[3].Payload["text"])
	}

	// The turn closed; a record after it belongs to nothing the relay saw start.
	writeSubWire(t, r.wirePath("agent-0"), []map[string]interface{}{
		kimiSubToolCall("tool_C", "Bash", map[string]interface{}{"command": "late"}),
	}, true)
	r.poll()
	if len(cap.events) != 4 {
		t.Fatalf("records past turn.ended fold nowhere; got %v", cap.types()[4:])
	}
}

func TestKimiSubRelaySkipsHistoryAtStart(t *testing.T) {
	dir := t.TempDir()
	main := filepath.Join(dir, "agents", "main", "wire.jsonl")
	sub := filepath.Join(dir, "agents", "agent-0", "wire.jsonl")
	writeSubWire(t, main, []map[string]interface{}{kimiAgentCallRecord("0", "tool_A", "old work")}, false)
	writeSubWire(t, sub, []map[string]interface{}{
		kimiSubPromptRecord("agent-0", "old work"),
		kimiSubToolCall("tool_B", "Bash", map[string]interface{}{"command": "ls"}),
	}, false)

	cap := &kimiRelayCapture{}
	r := newKimiSubRelay(dir, filepath.Join(t.TempDir(), "state.json"), cap.emit)
	r.poll()
	r.poll()
	if len(cap.events) != 0 {
		t.Fatalf("wires that predate the process are history; got %v", cap.types())
	}

	// Work written after the start is new, and relays.
	writeSubWire(t, main, []map[string]interface{}{kimiAgentCallRecord("1", "tool_D", "new work")}, true)
	writeSubWire(t, sub, []map[string]interface{}{
		kimiSubPromptRecord("agent-0", "new work"),
		kimiSubToolCall("tool_E", "Read", map[string]interface{}{"path": "x.go"}),
	}, true)
	r.poll()
	if len(cap.events) != 1 || cap.events[0].Payload["parentToolUseId"] != "1:tool_D" {
		t.Fatalf("post-start work relays under the new call; got %v", cap.events)
	}
}

func TestKimiSubRelaySwarmBindsEachItem(t *testing.T) {
	dir := t.TempDir()
	cap := &kimiRelayCapture{}
	r := newKimiSubRelay(dir, filepath.Join(t.TempDir(), "state.json"), cap.emit)
	writeSubWire(t, r.mainWire, []map[string]interface{}{
		{"type": "context.append_loop_event", "event": map[string]interface{}{
			"type": "tool.call", "turnId": "0", "toolCallId": "tool_swarm", "name": "AgentSwarm",
			"args": map[string]interface{}{
				"prompt_template": "Review {{item}} for regressions.",
				"items":           []interface{}{"src/a.ts", "src/b.ts"},
			},
		}},
	}, false)
	writeSubWire(t, r.wirePath("agent-0"), []map[string]interface{}{
		kimiSubPromptRecord("agent-0", "Review src/a.ts for regressions."),
		kimiSubToolCall("tool_1", "Read", map[string]interface{}{"path": "a.ts"}),
	}, false)
	writeSubWire(t, r.wirePath("agent-1"), []map[string]interface{}{
		kimiSubPromptRecord("agent-1", "Review src/b.ts for regressions."),
		kimiSubToolCall("tool_2", "Read", map[string]interface{}{"path": "b.ts"}),
	}, false)
	r.poll()
	if len(cap.events) != 2 {
		t.Fatalf("each swarm item's wire binds to the one call; got %v", cap.types())
	}
	for _, ev := range cap.events {
		if ev.Payload["parentToolUseId"] != "0:tool_swarm" {
			t.Errorf("swarm child parentToolUseId = %v, want 0:tool_swarm", ev.Payload["parentToolUseId"])
		}
	}
	if cap.events[0].Payload["id"] == cap.events[1].Payload["id"] {
		t.Errorf("two agents' calls share an id: %v", cap.events[0].Payload["id"])
	}
}

func TestKimiSubRelayResumeBindsByAgentID(t *testing.T) {
	dir := t.TempDir()
	// The sub-agent is old: its wire predates this process and is read from its end.
	writeSubWire(t, filepath.Join(dir, "agents", "agent-0", "wire.jsonl"), []map[string]interface{}{
		kimiSubPromptRecord("agent-0", "the original task"),
		kimiSubToolCall("tool_old", "Bash", map[string]interface{}{"command": "ls"}),
	}, false)
	cap := &kimiRelayCapture{}
	r := newKimiSubRelay(dir, filepath.Join(t.TempDir(), "state.json"), cap.emit)
	r.poll()

	writeSubWire(t, r.mainWire, []map[string]interface{}{
		{"type": "context.append_loop_event", "event": map[string]interface{}{
			"type": "tool.call", "turnId": "2", "toolCallId": "tool_R", "name": "Agent",
			"args": map[string]interface{}{"resume": "agent-0", "prompt": "continue"},
		}},
	}, false)
	writeSubWire(t, r.wirePath("agent-0"), []map[string]interface{}{
		kimiSubPromptRecord("agent-0", "continue"),
		kimiSubToolCall("tool_new", "Bash", map[string]interface{}{"command": "pwd"}),
	}, true)
	r.poll()
	// A resumed sub-agent's prompt is the parent's word ("continue"), which need not match
	// anything — the resume arg names the directory.
	if len(cap.events) != 1 || cap.events[0].Payload["parentToolUseId"] != "2:tool_R" {
		t.Fatalf("resume binds by agent id; got %v", cap.events)
	}
}

func TestKimiSubRelayNestedAgent(t *testing.T) {
	dir := t.TempDir()
	cap := &kimiRelayCapture{}
	r := newKimiSubRelay(dir, filepath.Join(t.TempDir(), "state.json"), cap.emit)
	writeSubWire(t, r.mainWire, []map[string]interface{}{
		kimiAgentCallRecord("0", "tool_A", "outer"),
	}, false)
	writeSubWire(t, r.wirePath("agent-0"), []map[string]interface{}{
		kimiSubPromptRecord("agent-0", "outer"),
		kimiSubToolCall("tool_N", "Agent", map[string]interface{}{"subagent_type": "coder", "prompt": "inner"}),
	}, false)
	writeSubWire(t, r.wirePath("agent-1"), []map[string]interface{}{
		kimiSubPromptRecord("agent-1", "inner"),
		kimiSubToolCall("tool_G", "Edit", map[string]interface{}{"path": "x"}),
	}, false)
	// A poll reads the sub-agent wires in map order. When agent-1's comes first, the Agent call its
	// prompt binds to has not been read yet: the wire is held at the prompt and the next poll binds
	// it. Two polls relay both calls, in this order, whichever wire a poll reads first.
	r.poll()
	r.poll()

	got := cap.types()
	want := []string{evToolUse, evToolUse}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("events = %v, want the sub's own Agent call and the grandchild's call", got)
	}
	outer := cap.events[0].Payload
	if outer["parentToolUseId"] != "0:tool_A" || outer["id"] != "agent-0:tool_N" {
		t.Fatalf("the sub's Agent call nests under the main card: %v", outer)
	}
	inner := cap.events[1].Payload
	if inner["parentToolUseId"] != "agent-0:tool_N" || inner["id"] != "agent-1:tool_G" {
		t.Fatalf("the grandchild binds to the composite id its parent's card was emitted with: %v", inner)
	}
}

func TestKimiSubRelayHoldsUnclaimedPrompt(t *testing.T) {
	dir := t.TempDir()
	cap := &kimiRelayCapture{}
	r := newKimiSubRelay(dir, filepath.Join(t.TempDir(), "state.json"), cap.emit)
	// The sub-agent's prompt raced ahead of the main wire's tool.call flush.
	writeSubWire(t, r.wirePath("agent-0"), []map[string]interface{}{
		kimiSubPromptRecord("agent-0", "wait for it"),
		kimiSubToolCall("tool_B", "Bash", map[string]interface{}{"command": "ls"}),
	}, false)

	r.mu.Lock()
	r.pollLocked(time.Unix(1000, 0))
	r.mu.Unlock()
	if len(cap.events) != 0 {
		t.Fatalf("an unbound turn relays nothing; got %v", cap.types())
	}
	tail := r.subs["agent-0"]
	if tail == nil || tail.heldSince.IsZero() {
		t.Fatalf("the wire holds at the prompt instead of dropping the turn: %+v", tail)
	}

	// The launching call's record lands; the next poll binds and relays what waited.
	writeSubWire(t, r.mainWire, []map[string]interface{}{kimiAgentCallRecord("0", "tool_A", "wait for it")}, false)
	r.mu.Lock()
	r.pollLocked(time.Unix(1001, 0))
	r.mu.Unlock()
	if len(cap.events) != 1 || cap.events[0].Payload["parentToolUseId"] != "0:tool_A" {
		t.Fatalf("the held wire binds once the call is known; got %v", cap.events)
	}

	// And a prompt no call ever claims is stepped over past the grace, not held forever.
	writeSubWire(t, r.wirePath("agent-0"), []map[string]interface{}{
		kimiSubPromptRecord("agent-0", "nobody sent this"),
		kimiSubToolCall("tool_C", "Bash", map[string]interface{}{"command": "x"}),
	}, true)
	before := len(cap.events)
	r.mu.Lock()
	r.pollLocked(time.Unix(2000, 0))
	r.pollLocked(time.Unix(2000, 0).Add(kimiSubBindGrace + time.Second))
	r.mu.Unlock()
	if len(cap.events) != before {
		t.Fatalf("an unclaimable turn is skipped past the grace; got %v", cap.types()[before:])
	}
}

func TestKimiSubRelayOffsetsPersistAcrossRestart(t *testing.T) {
	dir := t.TempDir()
	statePath := filepath.Join(t.TempDir(), "state.json")
	cap := &kimiRelayCapture{}
	r := newKimiSubRelay(dir, statePath, cap.emit)
	writeSubWire(t, r.mainWire, []map[string]interface{}{kimiAgentCallRecord("0", "tool_A", "work")}, false)
	writeSubWire(t, r.wirePath("agent-0"), []map[string]interface{}{
		kimiSubPromptRecord("agent-0", "work"),
		kimiSubToolCall("tool_B", "Bash", map[string]interface{}{"command": "ls"}),
	}, false)
	r.poll()
	r.stop()
	if len(cap.events) != 1 {
		t.Fatalf("setup: got %v", cap.types())
	}

	// The respawned process continues where the last one saved, even with the records still on disk.
	r2 := newKimiSubRelay(dir, statePath, cap.emit)
	r2.poll()
	if len(cap.events) != 1 {
		t.Fatalf("a restart re-emits nothing; got %v", cap.types()[1:])
	}
	writeSubWire(t, r2.wirePath("agent-0"), []map[string]interface{}{
		kimiSubToolResult("tool_B", "done\n"),
	}, true)
	r2.poll()
	if len(cap.events) != 2 || cap.events[1].Type != evToolResult {
		t.Fatalf("only the tail written since relays; got %v", cap.types()[1:])
	}
}

func TestKimiPromptMatches(t *testing.T) {
	cases := []struct {
		received, sent string
		want           bool
	}{
		{"do the thing", "do the thing", true},
		{"<git-context>\nWorking directory: /r\n</git-context>\n\ndo the thing", "do the thing", true},
		{"some notice line\ndo the thing", "do the thing", true}, // a wrapper ends with the prompt
		{"do the thing, but differently", "do the thing", false},
		{"prefix do the thing", "do the thing", false}, // not a line boundary
		{"", "do the thing", false},
	}
	for _, tc := range cases {
		if got := kimiPromptMatches(tc.received, tc.sent); got != tc.want {
			t.Errorf("kimiPromptMatches(%q, %q) = %v, want %v", tc.received, tc.sent, got, tc.want)
		}
	}
}

func TestKimiReadWireLines(t *testing.T) {
	path := filepath.Join(t.TempDir(), "wire.jsonl")
	writeSubWire(t, path, []map[string]interface{}{{"type": "a"}, {"type": "b"}}, false)
	// A trailing partial line waits for its newline.
	f, _ := os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0o600)
	_, _ = f.WriteString(`{"type":"c`)
	f.Close()

	lines := kimiReadWireLines(path, 0)
	if len(lines) != 2 || lines[0].rec["type"] != "a" || lines[1].rec["type"] != "b" {
		t.Fatalf("complete lines read; got %v", lines)
	}
	if lines[1].end <= lines[0].end {
		t.Fatalf("offsets advance: %v, %v", lines[0].end, lines[1].end)
	}
	if rest := kimiReadWireLines(path, lines[1].end); len(rest) != 0 {
		t.Fatalf("the partial line waits; got %v", rest)
	}
	writeSubWire(t, path, []map[string]interface{}{{"type": "c-fragment"}}, true) // completes as garbage + a line
	_ = lines
}

func TestKimiWireTurnID(t *testing.T) {
	if got := kimiWireTurnID(map[string]interface{}{"turnId": "0"}); got != "0" {
		t.Errorf(`string turnId: got %q`, got)
	}
	if got := kimiWireTurnID(map[string]interface{}{"turnId": float64(3)}); got != "3" {
		t.Errorf(`numeric turnId: got %q`, got)
	}
	if got := kimiWireTurnID(map[string]interface{}{"turnId": json.Number("7")}); got != "7" {
		t.Errorf(`json.Number turnId: got %q`, got)
	}
}
