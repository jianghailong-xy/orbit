package main

import (
	"encoding/json"
	"strings"
	"testing"
)

// decodeFrame parses one rendered JSONL line, asserting the framing (exactly one line,
// newline-terminated) that the stdin writer depends on.
func decodeFrame(t *testing.T, line string) map[string]interface{} {
	t.Helper()
	if !strings.HasSuffix(line, "\n") {
		t.Fatalf("frame is not newline-terminated: %q", line)
	}
	if strings.Count(line, "\n") != 1 {
		t.Fatalf("frame spans more than one JSONL line: %q", line)
	}
	var m map[string]interface{}
	if err := json.Unmarshal([]byte(line), &m); err != nil {
		t.Fatalf("frame is not JSON: %v (%q)", err, line)
	}
	return m
}

// A user frame carries the whole documented shape, not just the content: the CLI's own
// SDK writes parent_tool_use_id and session_id on every user message it feeds, and
// --replay-user-messages echoes them back for acknowledgment.
func TestUserFrameCarriesProtocolFields(t *testing.T) {
	content := []map[string]interface{}{
		{"type": "text", "text": "hello"},
	}
	m := decodeFrame(t, userFrame("sess-uuid-1", content))

	if m["type"] != "user" {
		t.Errorf("type = %v, want user", m["type"])
	}
	if m["session_id"] != "sess-uuid-1" {
		t.Errorf("session_id = %v, want sess-uuid-1", m["session_id"])
	}
	// Present AND null: Orbit only ever feeds top-level turns, and an absent key is not
	// the same statement as an explicit "this belongs to no tool call".
	v, ok := m["parent_tool_use_id"]
	if !ok || v != nil {
		t.Errorf("parent_tool_use_id = %v (present=%v), want explicit null", v, ok)
	}
	msg, _ := m["message"].(map[string]interface{})
	if msg == nil || msg["role"] != "user" {
		t.Fatalf("message = %v, want role user", m["message"])
	}
	blocks, _ := msg["content"].([]interface{})
	if len(blocks) != 1 {
		t.Fatalf("content = %v, want 1 block", msg["content"])
	}
	block, _ := blocks[0].(map[string]interface{})
	if block["type"] != "text" || block["text"] != "hello" {
		t.Errorf("content block = %v, want the text block verbatim", blocks[0])
	}
}

// Multi-block content (an upload plus text) survives whole and in order — the frame must
// not flatten or reorder what the caller assembled.
func TestUserFrameKeepsContentBlockOrder(t *testing.T) {
	content := []map[string]interface{}{
		{"type": "image", "source": map[string]interface{}{"type": "base64", "data": "AAA"}},
		{"type": "text", "text": "what is this"},
	}
	msg := decodeFrame(t, userFrame("s", content))["message"].(map[string]interface{})
	blocks := msg["content"].([]interface{})
	if len(blocks) != 2 {
		t.Fatalf("content = %v, want 2 blocks", blocks)
	}
	if blocks[0].(map[string]interface{})["type"] != "image" ||
		blocks[1].(map[string]interface{})["type"] != "text" {
		t.Errorf("blocks reordered: %v", blocks)
	}
}

func TestControlRequestFrame(t *testing.T) {
	m := decodeFrame(t, controlRequestFrame("req-7", "interrupt"))
	if m["type"] != "control_request" {
		t.Errorf("type = %v, want control_request", m["type"])
	}
	if m["request_id"] != "req-7" {
		t.Errorf("request_id = %v, want req-7", m["request_id"])
	}
	req, _ := m["request"].(map[string]interface{})
	if req == nil || req["subtype"] != "interrupt" {
		t.Errorf("request = %v, want subtype interrupt", m["request"])
	}
}

// A control_response answers exactly one request, and says so inside its response object.
// Routing a reply to the caller waiting on it depends on that id surviving the round trip.
func TestControlResponseCorrelatesByRequestID(t *testing.T) {
	sent := decodeFrame(t, controlRequestFrame("req-1", "can_use_tool"))
	id, _ := sent["request_id"].(string)

	answer := decodeFrame(t, controlResponseFrame(id, map[string]interface{}{"behavior": "allow"}))
	got, ok := parseControlResponse(answer)
	if !ok {
		t.Fatalf("parseControlResponse rejected %v", answer)
	}
	if got.RequestID != id {
		t.Errorf("RequestID = %q, want %q", got.RequestID, id)
	}
	if got.Subtype != "success" {
		t.Errorf("Subtype = %q, want success", got.Subtype)
	}
	if got.Response["behavior"] != "allow" {
		t.Errorf("Response = %v, want behavior allow", got.Response)
	}

	// A reply to some other request must not satisfy this one.
	other, _ := parseControlResponse(decodeFrame(t, controlResponseFrame("req-2", nil)))
	if other.RequestID == id {
		t.Errorf("reply to req-2 correlated with %q", id)
	}
}

func TestControlErrorFrame(t *testing.T) {
	got, ok := parseControlResponse(decodeFrame(t, controlErrorFrame("req-3", "boom")))
	if !ok {
		t.Fatal("parseControlResponse rejected an error frame")
	}
	if got.RequestID != "req-3" || got.Subtype != "error" || got.Error != "boom" {
		t.Errorf("parsed = %+v, want req-3/error/boom", got)
	}
	if got.Response != nil {
		t.Errorf("Response = %v, want nil on an error answer", got.Response)
	}
}

// The read side: a control_request the CLI sends us (permission prompts arrive this way)
// unpacks with its whole request object, since every subtype carries its own fields.
func TestParseControlRequest(t *testing.T) {
	req, ok := parseControlRequest(map[string]interface{}{
		"type": "control_request", "request_id": "req-9",
		"request": map[string]interface{}{
			"subtype": "can_use_tool", "tool_name": "Bash",
			"input": map[string]interface{}{"command": "ls"}, "tool_use_id": "toolu_1",
		},
	})
	if !ok {
		t.Fatal("parseControlRequest rejected a can_use_tool request")
	}
	if req.RequestID != "req-9" || req.Subtype != "can_use_tool" {
		t.Errorf("parsed = %+v, want req-9/can_use_tool", req)
	}
	if req.Request["tool_name"] != "Bash" {
		t.Errorf("Request = %v, want tool_name Bash", req.Request)
	}
}

// Frames that cannot be answered — wrong type, or no id to answer to — are rejected
// rather than parsed into a blank id that would correlate with everything.
func TestParseControlRejectsUnanswerableFrames(t *testing.T) {
	cases := []struct {
		name string
		msg  map[string]interface{}
	}{
		{"assistant message", map[string]interface{}{"type": "assistant"}},
		{"request without id", map[string]interface{}{
			"type": "control_request", "request": map[string]interface{}{"subtype": "interrupt"}}},
		{"request without body", map[string]interface{}{"type": "control_request", "request_id": "x"}},
	}
	for _, c := range cases {
		if _, ok := parseControlRequest(c.msg); ok {
			t.Errorf("parseControlRequest accepted %s", c.name)
		}
	}
	respCases := []struct {
		name string
		msg  map[string]interface{}
	}{
		{"result message", map[string]interface{}{"type": "result"}},
		{"response without body", map[string]interface{}{"type": "control_response"}},
		{"response without id", map[string]interface{}{
			"type": "control_response", "response": map[string]interface{}{"subtype": "success"}}},
	}
	for _, c := range respCases {
		if _, ok := parseControlResponse(c.msg); ok {
			t.Errorf("parseControlResponse accepted %s", c.name)
		}
	}
}
