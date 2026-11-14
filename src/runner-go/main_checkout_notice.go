package main

import (
	"encoding/json"
	"sync"
)

// Main checkout result lines in a live session (docs/main-checkout-git-contract.md §10.3).
//
// The control plane writes each main checkout outcome as one system line into the session the person pressed it in.
// While that session is live here, this runner numbers its events itself and keeps the counter in memory, so a row the
// control plane wrote at max(seq)+1 would take the seq the next event is about to use, and that event would be dropped
// as a duplicate. So for a live session the control plane queues an inbox turn of kind `notice` instead, carrying the
// line (a MainCheckoutResultNotice), and the runner emits it here as a system event through the session's own emitter:
// it takes the next seq like every other event. The turn never reaches the agent, opens no turn and changes no
// session state; the control plane answers it as it hands it out, like a diff or an interrupt.
//
// The inbox poller (inbox_poller.go) takes a notice off the stream before any session loop sees it, so no engine's
// switch needs to know the kind. The session supervisor (session.go) registers where the session's events go.

// mainCheckoutNoticeKind is the inbox turn kind that carries a main checkout result line.
const mainCheckoutNoticeKind = "notice"

// mainCheckoutNoticeSinks routes a session's notices to its emitter, by decoded session id.
var mainCheckoutNoticeSinks sync.Map

type mainCheckoutNoticeSink struct{ emit emitTurnFn }

// registerMainCheckoutNotices routes a session's notice turns to emitFor until the returned func is called.
func registerMainCheckoutNotices(sessionID string, emitFor emitTurnFn) func() {
	key := decodeSessionID(sessionID)
	sink := &mainCheckoutNoticeSink{emit: emitFor}
	mainCheckoutNoticeSinks.Store(key, sink)
	return func() { mainCheckoutNoticeSinks.CompareAndDelete(key, sink) }
}

// takeMainCheckoutNotice handles resp when it is a notice turn and reports whether it was one. Its line is emitted as a
// session-level system event (no turn id) carrying the payload as the control plane wrote it. A notice whose content
// is not an object, or that arrives for a session with nothing registered, is logged and dropped: the outcome is still
// on the control plane's request, and a line made up here would be worse than none.
func takeMainCheckoutNotice(sessionID string, resp *RunInboxResponse) bool {
	if resp == nil || resp.Kind != mainCheckoutNoticeKind {
		return false
	}
	var payload map[string]interface{}
	if err := json.Unmarshal([]byte(resp.Content), &payload); err != nil || payload == nil {
		logln("main checkout notice", resp.TurnID, "for", sessionID, "is not an object; dropped")
		return true
	}
	sink, ok := mainCheckoutNoticeSinks.Load(decodeSessionID(sessionID))
	if !ok {
		logln("main checkout notice", resp.TurnID, "for", sessionID, "has no session emitter here; dropped")
		return true
	}
	sink.(*mainCheckoutNoticeSink).emit("", evSystem, payload)
	return true
}
