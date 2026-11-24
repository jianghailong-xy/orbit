package main

import (
	"encoding/json"
	"net/http"
	"os"
	"strings"
)

// `orbit mcp` serving an Ask (help_ask.go): spawned with ORBIT_HELP_ASK=1, it lists the four help reads and nothing
// else, and answers any other tool's call with a refusal, before anything reaches the control plane. Every read is
// sent with the Ask's session header, which is what the control plane's four doors answer (help-ask-reads.ts) and
// what its fence refuses at every other runner door.

// helpAskModeFromEnv reports whether this `orbit mcp` serves an Ask.
func helpAskModeFromEnv() bool {
	return strings.TrimSpace(os.Getenv(envHelpAsk)) == "1"
}

var helpAskToolDescriptions = map[string]string{
	"machines": "Every machine (runner) on the person's account: its name and id, whether it is online, when Orbit last heard from it (lastHeartbeatAt, secondsSinceHeartbeat), its runner version, and which engines are installed and signed in. Read-only.",
	"sessions": "The person's newest sessions: title, status (PENDING, RUNNING, AWAITING_INPUT, INTERRUPTED = paused, COMPLETED, FAILED), the machine and workspace each runs in, its error if it has one, and when it last did something. Never what was said in them. Read-only.",
	"tasks":    "The person's open, in-progress and failed tasks: title, status, whether dispatch is held, and the project. Read-only.",
	"quota":    "Each machine's engine quota windows as its last heartbeat reported them (5-hour and 7-day usage, resets), and any account paused for its usage limit. Read-only.",
}

// helpAskToolDescriptors is tools/list for an Ask.
func helpAskToolDescriptors() []map[string]interface{} {
	tools := make([]map[string]interface{}, 0, len(helpAskReads))
	for _, read := range helpAskReads {
		tools = append(tools, map[string]interface{}{
			"name":        helpAskToolName(read),
			"description": helpAskToolDescriptions[read],
			"inputSchema": map[string]interface{}{"type": "object", "properties": map[string]interface{}{}, "additionalProperties": false},
			"annotations": map[string]interface{}{"readOnlyHint": true},
		})
	}
	return tools
}

// helpAskRead is the read a tool name names, or "".
func helpAskRead(name string) string {
	for _, read := range helpAskReads {
		if name == helpAskToolName(read) {
			return read
		}
	}
	return ""
}

// callHelpAskTool answers one tools/call of an Ask: a read, or the refusal of anything else.
func (s *mcpServer) callHelpAskTool(name string) map[string]interface{} {
	read := helpAskRead(name)
	if read == "" {
		return toolResult(name+" is not available: an Ask is read-only, and has only help_machines, help_sessions, help_tasks and help_quota", true)
	}
	if strings.TrimSpace(s.sessionID) == "" {
		return toolResult("no session context (ORBIT_SESSION_ID unset)", true)
	}
	var out json.RawMessage
	err := s.t.doHeaders(nil, http.MethodGet, "/runner/help-ask/"+read, nil, &out, taskOpTimeout, sessionHeader(strings.TrimSpace(s.sessionID)))
	if err != nil {
		return toolResult("the read failed: "+err.Error(), true)
	}
	return toolResult(string(out), false)
}
