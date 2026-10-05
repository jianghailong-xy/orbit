package main

import (
	"encoding/json"
	"fmt"
	"strings"
	"sync"
)

type dshActiveTurn struct {
	id        string
	text      strings.Builder
	seen      map[string]bool
	tools     map[string]bool // false until a terminal tool update arrives
	toolOrder []string
}

// dsh projects committed message blocks onto ACP. Their chunk names do not mean
// provider token deltas, so each block becomes one assistant/thinking event.
type dshEventMapper struct {
	mu          sync.Mutex
	sessionID   string
	emitFor     emitTurnFn
	active      *dshActiveTurn
	settled     map[string]bool
	contextUsed *int
	contextSize *int
}

func newDshEventMapper(sessionID string, emitFor emitTurnFn) *dshEventMapper {
	return &dshEventMapper{sessionID: sessionID, emitFor: emitFor, settled: map[string]bool{}}
}

func (m *dshEventMapper) begin(turnID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if turnID == "" {
		return fmt.Errorf("dsh turn id is empty")
	}
	if m.active != nil {
		return fmt.Errorf("dsh turn %s is still active", m.active.id)
	}
	if m.settled[turnID] {
		return fmt.Errorf("dsh turn %s has already settled", turnID)
	}
	m.active = &dshActiveTurn{id: turnID, seen: map[string]bool{}, tools: map[string]bool{}}
	return nil
}

func (m *dshEventMapper) emit(turnID, kind string, payload map[string]interface{}) {
	payload["runtimeSessionId"] = m.sessionID
	if turnID != "" {
		payload["localTurnId"] = turnID
	}
	m.emitFor(turnID, kind, payload)
}

func (m *dshEventMapper) context(payload map[string]interface{}) map[string]interface{} {
	if m.contextUsed != nil {
		payload["contextTokens"] = *m.contextUsed
	}
	if m.contextSize != nil {
		payload["contextWindow"] = *m.contextSize
	}
	return payload
}

func (m *dshEventMapper) update(params map[string]interface{}) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if id := firstString(params, "sessionId"); id != m.sessionID {
		return fmt.Errorf("dsh update belongs to session %q, expected %q", id, m.sessionID)
	}
	update := mapValue(params["update"])
	if update == nil {
		return fmt.Errorf("dsh session update is missing")
	}
	kind := firstString(update, "sessionUpdate")
	turnID := ""
	if m.active != nil {
		turnID = m.active.id
	}
	switch kind {
	case "usage_update":
		if used, ok := dshUsageCount(update["used"]); ok {
			m.contextUsed = &used
		}
		if size, ok := dshUsageCount(update["size"]); ok && size > 0 {
			m.contextSize = &size
		}
		if turnID != "" && (m.contextUsed != nil || m.contextSize != nil) {
			m.emit(turnID, evSystem, m.context(map[string]interface{}{"subtype": "context"}))
		}
		return nil
	case "config_option_update":
		m.emit(turnID, evSystem, map[string]interface{}{
			"subtype": "config_changed", "configOptions": update["configOptions"],
		})
		return nil
	}
	if m.active == nil {
		return nil
	}
	a := m.active
	switch kind {
	case "agent_message_chunk", "agent_thought_chunk":
		id := firstString(update, "messageId")
		if id == "" {
			return fmt.Errorf("dsh %s is missing messageId", kind)
		}
		content := mapValue(update["content"])
		if firstString(content, "type") != "text" {
			return nil
		}
		text := firstString(content, "text")
		if text == "" {
			return nil
		}
		wire, err := json.Marshal(update)
		if err != nil {
			return fmt.Errorf("dsh message block: %w", err)
		}
		key := string(wire)
		if a.seen[key] {
			return nil
		}
		a.seen[key] = true
		event := evThinking
		if kind == "agent_message_chunk" {
			event = evAssistant
			a.text.WriteString(text)
		}
		m.emit(turnID, event, map[string]interface{}{"text": text, "messageId": id})
	case "tool_call", "tool_call_update":
		id := firstString(update, "toolCallId")
		if id == "" {
			return fmt.Errorf("dsh %s is missing toolCallId", kind)
		}
		done, known := a.tools[id]
		if kind == "tool_call" && !known {
			a.tools[id] = false
			a.toolOrder = append(a.toolOrder, id)
			m.emit(turnID, evToolUse, map[string]interface{}{
				"id": id, "toolCallId": id, "name": update["title"],
				"input": update["rawInput"], "kind": update["kind"], "status": update["status"],
			})
		} else if !known {
			return fmt.Errorf("dsh tool update references unknown tool %q", id)
		}
		status := firstString(update, "status")
		if !done && (status == "completed" || status == "failed") {
			a.tools[id] = true
			m.emit(turnID, evToolResult, map[string]interface{}{
				"toolUseId": id, "toolCallId": id, "status": status,
				"content": dshToolOutput(update), "isError": status == "failed",
			})
		}
	}
	return nil
}

func dshUsageCount(value interface{}) (int, bool) {
	switch value := value.(type) {
	case int:
		return value, value >= 0
	case float64:
		count := int(value)
		return count, count >= 0 && float64(count) == value
	}
	return 0, false
}

func dshToolOutput(update map[string]interface{}) string {
	var texts []string
	rows, _ := update["content"].([]interface{})
	for _, value := range rows {
		row := mapValue(value)
		content := mapValue(row["content"])
		if firstString(content, "type") == "text" {
			texts = append(texts, firstString(content, "text"))
		}
	}
	if len(texts) > 0 {
		return strings.Join(texts, "\n")
	}
	if raw, ok := update["rawOutput"].(string); ok {
		return raw
	}
	if raw := update["rawOutput"]; raw != nil {
		if wire, err := json.Marshal(raw); err == nil {
			return string(wire)
		}
	}
	return ""
}

// The client applies preceding notifications through its response barrier before
// settling. This lock then closes tools and the turn atomically, once per local id.
func (m *dshEventMapper) settle(turnID string, result map[string]interface{}, err error) (TurnCompleteRequest, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.active == nil || m.active.id != turnID {
		return TurnCompleteRequest{}, false
	}
	a := m.active
	request := TurnCompleteRequest{
		TurnID: turnID, Status: stSucceeded, Subtype: "completed", NumTurns: 1,
		Result: strings.TrimSpace(a.text.String()), RuntimeSessionID: m.sessionID,
	}
	stop := firstString(result, "stopReason")
	if err != nil {
		request.Status, request.Subtype, request.Error = stFailed, "error", err.Error()
	} else {
		switch stop {
		case "end_turn":
		case "cancelled":
			request.Status, request.Subtype = stInterrupted, "interrupted"
		case "max_tokens":
			request.Status, request.Subtype, request.Error = stFailed, "max_tokens", "dsh prompt reached the output token limit"
		case "refusal":
			request.Status, request.Subtype, request.Error = stFailed, "refusal", "dsh prompt refused"
		default:
			request.Status, request.Subtype, request.Error = stFailed, "error", fmt.Sprintf("dsh prompt returned unsupported stopReason %q", stop)
		}
	}
	for _, id := range a.toolOrder {
		if a.tools[id] {
			continue
		}
		if request.Status == stSucceeded {
			request.Status, request.Subtype, request.Error = stFailed, "error", "dsh prompt ended with unfinished tool calls"
		}
		m.emit(turnID, evToolResult, map[string]interface{}{
			"toolUseId": id, "toolCallId": id, "status": "failed", "isError": true,
			"content": "dsh ended before this tool returned a final status; side effects may have occurred",
		})
	}
	if request.Error != "" {
		m.emit(turnID, evError, map[string]interface{}{"message": request.Error})
	}
	end := m.context(map[string]interface{}{"subtype": request.Subtype, "numTurns": 1})
	if stop != "" {
		end["stopReason"] = stop
	}
	m.emit(turnID, evTurnEnd, end)
	m.active = nil
	m.settled[turnID] = true
	return request, true
}
