package main

import (
	"fmt"
	"sync"
)

// A runner stop that cuts a turn (the drain running out, or the owner's Update Now) kills the engine
// in the middle of whatever tool call it was making. The engine never reports that call's result, so
// Orbit's transcript keeps a `tool_use` with nothing after it: every client draws it as a command still
// running, forever (the restart probe of 2026-11-12: Codex's cut command stayed a grey pending row).
// Claude Code closes such a call in its own JSONL ("[Tool call interrupted: …]"); Orbit's transcript is
// closed the same way here, for every engine, from the one place all their events pass through.
//
// interruptedToolCalls follows, per turn, the tool calls opened (`tool_use`, by its `id`) and not yet
// answered (`tool_result`, by its `toolUseId`). When a runner stop's interrupt comes for a turn
// (stopInterruptPayload: reason runner_restart or runner_update), each call still open is answered
// first with a synthetic interrupted `tool_result`, then the interrupt follows. A turn that ends
// forgets its calls; an owner's Stop (no reason) is the engine's to report, as it always was.
type interruptedToolCalls struct {
	mu   sync.Mutex
	open map[string][]openToolCall
}

type openToolCall struct {
	id string
	// parentToolUseId, for a call a subagent made (claude's withParent): its result is filed the same way.
	parent interface{}
}

// interruptedToolResultText is what the synthetic result says, by what stopped the turn.
func interruptedToolResultText(reason string) string {
	cause := "the runner stopped"
	if reason == interruptReasonRunnerUpdate {
		cause = "the runner update stopped this turn"
	}
	return fmt.Sprintf("[Tool call interrupted: %s before this call's result was recorded, so its outcome is unknown. "+
		"Check whether it took effect before relying on it or running it again.]", cause)
}

// observe records one event about to be emitted for turnID, and returns the synthetic results to emit
// ahead of it: none, unless it is a runner stop's interrupt for a turn with calls still open.
func (c *interruptedToolCalls) observe(turnID, eventType string, payload map[string]interface{}) []map[string]interface{} {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.open == nil {
		c.open = map[string][]openToolCall{}
	}
	switch eventType {
	case evToolUse:
		if id := asString(payload["id"]); id != "" {
			c.open[turnID] = append(c.open[turnID], openToolCall{id: id, parent: payload["parentToolUseId"]})
		}
	case evToolResult:
		id := asString(payload["toolUseId"])
		calls := c.open[turnID]
		for i, call := range calls {
			if call.id == id {
				c.open[turnID] = append(calls[:i:i], calls[i+1:]...)
				break
			}
		}
	case evTurnEnd:
		delete(c.open, turnID)
	case evInterrupt:
		reason := asString(payload["reason"])
		if reason != interruptReasonRunnerRestart && reason != interruptReasonRunnerUpdate {
			return nil
		}
		calls := c.open[turnID]
		delete(c.open, turnID)
		results := make([]map[string]interface{}, 0, len(calls))
		for _, call := range calls {
			result := map[string]interface{}{
				"toolUseId":   call.id,
				"content":     interruptedToolResultText(reason),
				"isError":     true,
				"interrupted": reason,
			}
			if call.parent != nil {
				result["parentToolUseId"] = call.parent
			}
			results = append(results, result)
		}
		return results
	}
	return nil
}

// closingInterruptedToolCalls wraps an emitter so that a runner stop's interrupt is preceded by the
// synthetic results of the calls it leaves open (interruptedToolCalls). emitFor files an event
// against a turn; turn names the turn an event without one is filed against.
func closingInterruptedToolCalls(emitFor emitTurnFn, turn func() string) (emitFn, emitTurnFn) {
	calls := &interruptedToolCalls{}
	wrappedFor := func(turnID, eventType string, payload map[string]interface{}) {
		for _, result := range calls.observe(turnID, eventType, payload) {
			emitFor(turnID, evToolResult, result)
		}
		emitFor(turnID, eventType, payload)
	}
	return func(eventType string, payload map[string]interface{}) { wrappedFor(turn(), eventType, payload) }, wrappedFor
}
