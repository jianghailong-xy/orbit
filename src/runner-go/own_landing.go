package main

// A task's own work session reading its task's landing (docs/project-integration-line-contract.md §12.5 W6, §12.7,
// revision 42). A landing that stopped on a conflict or a failed check is handed to the session that wrote the work,
// and its landing-fix turn names the record: "The full record: landing <landingSessionId>." session_get reads it,
// and the session must be able to whether or not the account has Session orchestration on.
//
// So a session of a task is offered session_get with orchestration off, and its call goes to the runner's own-landing
// door, GET /runner/landings/:id, as the calling session and without the orchestration credential. The server answers
// it only for a landing of this session's own task (SessionsService.ownTaskLandingForWorkSession) and refuses every
// other id with 404 LANDING_NOT_THIS_SESSIONS_TASK; the orchestration doors are unchanged.

import (
	"encoding/json"
	"net/url"
	"strings"
)

// ownLandingSessionGetNote is what session_get says of itself where it is offered for this alone.
const ownLandingSessionGetNote = " Session orchestration is off for this account, so this session can read one thing with it: " +
	"its own task's landing, by the landing session id its landing-fix turn names or task_get's " +
	"integration.landTask.landingSessionId. Any other session is refused."

// readsOwnTaskLanding is whether this session may read its task's landing with orchestration off: it is a session of a
// task, in an exact session context.
func (s *mcpServer) readsOwnTaskLanding() bool {
	return !s.orchestrationEnabled() && strings.TrimSpace(s.sessionID) != "" && strings.TrimSpace(s.taskID) != ""
}

// withOwnLandingSessionGet adds session_get to a task session's tools when orchestration left it out.
func withOwnLandingSessionGet(tools []map[string]interface{}) []map[string]interface{} {
	op := catalogOperation("session_get")
	if op == nil || op.MCP == nil {
		return tools
	}
	descriptor := map[string]interface{}{
		"name":        op.Tool,
		"description": op.MCP.Description + ownLandingSessionGetNote,
		"inputSchema": op.MCP.InputSchema,
	}
	for key, value := range op.MCP.Extra {
		descriptor[key] = value
	}
	return append(tools, descriptor)
}

// getOwnTaskLanding is GET /runner/landings/:id as the calling session, without the orchestration credential.
func (t *Transport) getOwnTaskLanding(callerSessionID, id string) (json.RawMessage, error) {
	if err := validatePathSegmentID(id); err != nil {
		return nil, err
	}
	var out json.RawMessage
	err := t.doHeaders(nil, "GET", "/runner/landings/"+url.PathEscape(id), nil, &out, taskOpTimeout,
		map[string]string{"X-Orbit-Session-Id": callerSessionID})
	return out, err
}
