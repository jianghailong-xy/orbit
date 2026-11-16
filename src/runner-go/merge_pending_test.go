package main

import (
	"encoding/json"
	"testing"
)

// A queued merge's answer names session_get as its next read; the server's own fields are kept as they were.
func TestMergePendingAnswerNamesSessionGet(t *testing.T) {
	raw := json.RawMessage(`{"ok":true,"outcome":"PENDING","sessionId":"s-1","operationId":"op-1","mergeStatus":"pending","receipt":null,"receiptAbsentReason":"MERGE_STILL_RUNNING","next":{"actionCode":"POLL_STATE","afterSeconds":30,"resources":[{"type":"SESSION","id":"s-1"}]}}`)
	var got map[string]interface{}
	if err := json.Unmarshal(withMergePendingCall(raw), &got); err != nil {
		t.Fatal(err)
	}
	if got["outcome"] != "PENDING" || got["ok"] != true || got["receipt"] != nil || got["operationId"] != "op-1" {
		t.Fatalf("the server's receipt changed: %v", got)
	}
	next := got["next"].(map[string]interface{})
	if next["tool"] != "session_get" || next["command"] != "orbit session get s-1" || next["actionCode"] != "POLL_STATE" || next["afterSeconds"] != float64(30) {
		t.Fatalf("next: %v", next)
	}
	if args := next["arguments"].(map[string]interface{}); args["sessionId"] != "s-1" {
		t.Fatalf("arguments: %v", args)
	}
}

// Anything else is passed through byte for byte: a settled merge, the Merge button's {ok:true}, an id that is
// not one safe path segment.
func TestMergePendingLeavesOtherAnswersAlone(t *testing.T) {
	for _, raw := range []string{
		`{"ok":true}`,
		`{"outcome":"SETTLED","mergeStatus":"merged","receipt":{"id":"r"},"nextStep":null}`,
		`{"outcome":"PENDING","next":{"actionCode":"POLL_STATE","resources":[{"type":"SESSION","id":"../x"}]}}`,
		`not json`,
	} {
		if got := string(withMergePendingCall(json.RawMessage(raw))); got != raw {
			t.Errorf("%s changed to %s", raw, got)
		}
	}
}
