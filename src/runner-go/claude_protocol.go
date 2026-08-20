package main

import "encoding/json"

// The stream-json frames Orbit exchanges with `claude -p --input-format stream-json
// --output-format stream-json`. Every frame written to the CLI's stdin is built here so
// the shapes stay identical across user turns, interrupts and permission answers, and so
// they can be pinned by contract tests without spawning a real CLI (claude_protocol_test.go).
//
// Shapes follow the CLI's own emitters:
//
//	user             {"type":"user","message":{"role":"user","content":[…]},
//	                  "parent_tool_use_id":null,"session_id":"…"}
//	control_request  {"type":"control_request","request_id":"…","request":{"subtype":"…",…}}
//	control_response {"type":"control_response","response":{"subtype":"success",
//	                  "request_id":"…","response":{…}}}
//	                 {"type":"control_response","response":{"subtype":"error",
//	                  "request_id":"…","error":"…"}}
//
// A control_response carries the request_id it answers INSIDE its response object — that
// nesting is what lets a reply be routed back to the request that is waiting for it.
const (
	frameUser            = "user"
	frameControlRequest  = "control_request"
	frameControlResponse = "control_response"

	ctrlSuccess = "success"
	ctrlError   = "error"
)

// marshalFrame renders one JSONL line, newline included, so no writer can forget the
// framing. Every value passed in is JSON-derived or built from literals here, so Marshal
// cannot fail; an impossible failure yields "" and is dropped by the writer's length check.
func marshalFrame(v map[string]interface{}) string {
	b, err := json.Marshal(v)
	if err != nil {
		return ""
	}
	return string(b) + "\n"
}

// userFrame carries one user turn: the content blocks (text and/or image blocks) of a
// prompt. parent_tool_use_id is always null — Orbit only ever feeds top-level turns;
// sub-agent messages are the CLI's own to attribute.
func userFrame(sessionID string, content []map[string]interface{}) string {
	return marshalFrame(map[string]interface{}{
		"type": frameUser,
		"message": map[string]interface{}{
			"role":    "user",
			"content": content,
		},
		"parent_tool_use_id": nil,
		"session_id":         sessionID,
	})
}

// controlRequestFrame asks the CLI to do something out of band of the conversation
// (currently only ctrlInterrupt). requestID is what the matching control_response echoes,
// and is what routes that answer back to this request (claude_control.go).
func controlRequestFrame(requestID, subtype string) string {
	return marshalFrame(map[string]interface{}{
		"type":       frameControlRequest,
		"request_id": requestID,
		"request":    map[string]interface{}{"subtype": subtype},
	})
}

// controlResponseFrame answers a control_request the CLI sent us (e.g. can_use_tool, whose
// response is {"behavior":"allow"|"deny",…}).
func controlResponseFrame(requestID string, response map[string]interface{}) string {
	return marshalFrame(map[string]interface{}{
		"type": frameControlResponse,
		"response": map[string]interface{}{
			"subtype":    ctrlSuccess,
			"request_id": requestID,
			"response":   response,
		},
	})
}

// controlErrorFrame answers a control_request we could not serve at all. Distinct from a
// deny: a denial is a successful answer whose payload refuses the tool.
func controlErrorFrame(requestID, errMsg string) string {
	return marshalFrame(map[string]interface{}{
		"type": frameControlResponse,
		"response": map[string]interface{}{
			"subtype":    ctrlError,
			"request_id": requestID,
			"error":      errMsg,
		},
	})
}

// claudeControlRequest is a control_request read off the CLI's stdout — the CLI asking
// Orbit for something (can_use_tool, request_user_dialog…). Request holds the whole
// request object, subtype included, since each subtype carries its own fields.
type claudeControlRequest struct {
	RequestID string
	Subtype   string
	Request   map[string]interface{}
}

// parseControlRequest reports whether msg is a control_request, and unpacks it. A frame
// without a request_id is not answerable, so it is rejected rather than answered blind.
func parseControlRequest(msg map[string]interface{}) (claudeControlRequest, bool) {
	if msg["type"] != frameControlRequest {
		return claudeControlRequest{}, false
	}
	req, _ := msg["request"].(map[string]interface{})
	id, _ := msg["request_id"].(string)
	if req == nil || id == "" {
		return claudeControlRequest{}, false
	}
	subtype, _ := req["subtype"].(string)
	return claudeControlRequest{RequestID: id, Subtype: subtype, Request: req}, true
}

// claudeControlResponse is the CLI's answer to a control_request Orbit sent. RequestID is
// what correlates it with the pending request; Subtype is "success" or "error".
type claudeControlResponse struct {
	RequestID string
	Subtype   string
	Error     string
	Response  map[string]interface{}
}

func parseControlResponse(msg map[string]interface{}) (claudeControlResponse, bool) {
	if msg["type"] != frameControlResponse {
		return claudeControlResponse{}, false
	}
	resp, _ := msg["response"].(map[string]interface{})
	if resp == nil {
		return claudeControlResponse{}, false
	}
	id, _ := resp["request_id"].(string)
	if id == "" {
		return claudeControlResponse{}, false
	}
	subtype, _ := resp["subtype"].(string)
	errMsg, _ := resp["error"].(string)
	payload, _ := resp["response"].(map[string]interface{})
	return claudeControlResponse{RequestID: id, Subtype: subtype, Error: errMsg, Response: payload}, true
}
