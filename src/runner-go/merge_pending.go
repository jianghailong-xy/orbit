package main

import "encoding/json"

// withMergePendingCall names the call that reads a merge that has no outcome yet. The server answers a
// queued or still-running merge with outcome PENDING or TIMED_OUT and a semantic next step, POLL_STATE on
// the session (docs/recovery-contract.md §9.3); it never names a tool. This adds the tool, the command
// and the arguments the read takes on this surface, beside what the server said, the same way
// session_create(wait) names session_get (session_wait.go). Any other answer comes back unchanged.
func withMergePendingCall(raw json.RawMessage) json.RawMessage {
	var answer map[string]interface{}
	if err := json.Unmarshal(raw, &answer); err != nil {
		return raw
	}
	next, ok := answer["next"].(map[string]interface{})
	if !ok || next["actionCode"] != "POLL_STATE" {
		return raw
	}
	resources, _ := next["resources"].([]interface{})
	for _, r := range resources {
		res, _ := r.(map[string]interface{})
		id, _ := res["id"].(string)
		if res["type"] != "SESSION" || !recoveryResourceID(id) {
			continue
		}
		next["tool"] = "session_get"
		next["command"] = "orbit session get " + id
		next["arguments"] = map[string]string{"sessionId": id}
		out, err := json.Marshal(answer)
		if err != nil {
			return raw
		}
		return out
	}
	return raw
}
