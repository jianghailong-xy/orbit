package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"reflect"
	"strings"
	"testing"
)

type dshMappingEvent struct {
	turnID  string
	kind    string
	payload map[string]interface{}
}

type dshRecordedRow struct {
	Seq      int                    `json:"seq"`
	Scenario string                 `json:"scenario"`
	Channel  string                 `json:"channel"`
	Value    map[string]interface{} `json:"value"`
}

func dshReadRecording(t *testing.T) []dshRecordedRow {
	t.Helper()
	data, err := os.ReadFile("../../docs/evidence/deepseek-harness/dsh-v0.2.0-rc.2/protocol.ndjson")
	if err != nil {
		t.Fatal(err)
	}
	var rows []dshRecordedRow
	for _, line := range bytes.Split(bytes.TrimSpace(data), []byte{'\n'}) {
		var row dshRecordedRow
		if err := json.Unmarshal(line, &row); err != nil {
			t.Fatal(err)
		}
		rows = append(rows, row)
	}
	return rows
}

// Replay the official P0 wire ordering, opening a local turn on each recorded
// prompt request and settling only at that request's recorded response.
func dshReplayRecording(t *testing.T, scenarios ...string) ([]dshMappingEvent, []TurnCompleteRequest) {
	t.Helper()
	selected := map[string]bool{}
	for _, name := range scenarios {
		selected[name] = true
	}
	var mapper *dshEventMapper
	var events []dshMappingEvent
	var completions []TurnCompleteRequest
	prompts := map[string]string{}
	for _, row := range dshReadRecording(t) {
		if !selected[row.Scenario] {
			continue
		}
		msg := row.Value
		if row.Channel == "acp/in" && msg["method"] == "session/prompt" {
			params := mapValue(msg["params"])
			if mapper == nil {
				mapper = newDshEventMapper(firstString(params, "sessionId"), func(turnID, kind string, payload map[string]interface{}) {
					events = append(events, dshMappingEvent{turnID, kind, payload})
				})
			}
			turnID := fmt.Sprintf("recorded-turn-%d", row.Seq)
			if err := mapper.begin(turnID); err != nil {
				t.Fatal(err)
			}
			prompts[fmt.Sprint(msg["id"])] = turnID
		}
		if row.Channel != "acp/out" || mapper == nil {
			continue
		}
		if msg["method"] == "session/update" {
			if err := mapper.update(mapValue(msg["params"])); err != nil {
				t.Fatalf("recorded seq %d: %v", row.Seq, err)
			}
			continue
		}
		turnID := prompts[fmt.Sprint(msg["id"])]
		if turnID == "" {
			continue
		}
		var promptErr error
		if rpcError := mapValue(msg["error"]); rpcError != nil {
			promptErr = errors.New(firstString(rpcError, "message"))
		}
		completion, settled := mapper.settle(turnID, mapValue(msg["result"]), promptErr)
		if !settled {
			t.Fatalf("recorded seq %d did not settle %s", row.Seq, turnID)
		}
		completions = append(completions, completion)
		delete(prompts, fmt.Sprint(msg["id"]))
	}
	if mapper == nil || len(prompts) != 0 || len(completions) == 0 {
		t.Fatalf("fixture scenarios were missing or incomplete: %v; pending=%v", scenarios, prompts)
	}
	return events, completions
}

func dshMappingEventsOf(events []dshMappingEvent, kind string) []dshMappingEvent {
	var out []dshMappingEvent
	for _, event := range events {
		if event.kind == kind {
			out = append(out, event)
		}
	}
	return out
}

func TestDshACPRecordedEventMapping(t *testing.T) {
	t.Run("committed_blocks_and_known_context", func(t *testing.T) {
		events, completions := dshReplayRecording(t, "committed-message-blocks-and-context-usage")
		var kinds []string
		for _, event := range events {
			kinds = append(kinds, event.kind)
			if event.payload["runtimeSessionId"] != "<UUID_174>" || event.payload["localTurnId"] != event.turnID {
				t.Fatalf("lost event identity: %+v", event)
			}
			if _, ok := event.payload["costUsd"]; ok {
				t.Fatalf("invented a cost: %+v", event)
			}
		}
		if !reflect.DeepEqual(kinds, []string{evThinking, evAssistant, evSystem, evTurnEnd}) {
			t.Fatalf("committed event order = %v", kinds)
		}
		if events[0].payload["text"] != "synthetic thinking" || events[1].payload["text"] != "alpha-beta-gamma" ||
			events[0].payload["messageId"] != "<UUID_179>" || events[1].payload["messageId"] != "<UUID_179>" {
			t.Fatalf("committed blocks were not preserved: %+v", events)
		}
		for _, event := range events[2:] {
			if event.payload["contextTokens"] != 5562 || event.payload["contextWindow"] != 1_000_000 {
				t.Fatalf("usage was not mapped: %+v", event)
			}
		}
		if len(completions) != 1 || completions[0].Status != stSucceeded || completions[0].Result != "alpha-beta-gamma" || completions[0].Usage != nil {
			t.Fatalf("completion = %+v", completions)
		}
	})
	t.Run("basic_multiturn", func(t *testing.T) {
		events, completions := dshReplayRecording(t, "initialize-new-text-thought", "second-turn")
		if len(completions) != 2 || completions[0].Result != "hello" || completions[1].Result != "second-turn" {
			t.Fatalf("multiturn completions = %+v", completions)
		}
		ends := dshMappingEventsOf(events, evTurnEnd)
		if len(ends) != 2 || ends[0].turnID == ends[1].turnID || ends[1].payload["contextTokens"] != 5580 {
			t.Fatalf("multiturn ends = %+v", ends)
		}
		for _, completion := range completions {
			if completion.Status != stSucceeded || completion.RuntimeSessionID != "<UUID_1>" {
				t.Fatalf("lost shared runtime identity: %+v", completion)
			}
		}
	})
	t.Run("native_tools_and_failed_tool", func(t *testing.T) {
		events, completions := dshReplayRecording(t, "native-write-read-and-tool-failure")
		uses, results := dshMappingEventsOf(events, evToolUse), dshMappingEventsOf(events, evToolResult)
		if len(uses) != 2 || len(results) != 2 || len(completions) != 2 {
			t.Fatalf("tool counts: use=%d result=%d completion=%d", len(uses), len(results), len(completions))
		}
		for i := range uses {
			if uses[i].turnID != results[i].turnID || uses[i].turnID != completions[i].TurnID ||
				uses[i].payload["id"] != results[i].payload["toolUseId"] ||
				uses[i].payload["toolCallId"] != results[i].payload["toolCallId"] || completions[i].Status != stSucceeded {
				t.Fatalf("tool attribution lost: use=%+v result=%+v completion=%+v", uses[i], results[i], completions[i])
			}
		}
		if uses[0].payload["name"] != "write" || mapValue(uses[0].payload["input"])["content"] != "native-side-effect" ||
			results[0].payload["isError"] != false || !strings.Contains(results[0].payload["content"].(string), "Created file") ||
			uses[1].payload["name"] != "read" || results[1].payload["isError"] != true ||
			!strings.Contains(results[1].payload["content"].(string), "not found") {
			t.Fatalf("native tool details lost: uses=%+v results=%+v", uses, results)
		}
	})
}

func TestDshACPStatusAndUnclosedTools(t *testing.T) {
	t.Run("recorded_errors_and_next_turn_recovery", func(t *testing.T) {
		events, completions := dshReplayRecording(t, "max-tokens-is-not-success", "http-errors-and-next-turn-recovery")
		if len(completions) != 7 || len(dshMappingEventsOf(events, evTurnEnd)) != 7 || completions[0].Status != stFailed || completions[0].Subtype != "max_tokens" {
			t.Fatalf("recorded result statuses = %+v", completions)
		}
		for i, code := range []string{"401", "429", "500"} {
			failed, recovered := completions[1+i*2], completions[2+i*2]
			if failed.Status != stFailed || !strings.Contains(failed.Error, "synthetic-"+code) || recovered.Status != stSucceeded || recovered.Error != "" {
				t.Fatalf("error leaked into the next turn: failed=%+v recovered=%+v", failed, recovered)
			}
		}
	})
	for _, test := range []struct {
		name, stop, status, subtype string
		err                         error
		open                        bool
	}{
		{"success", "end_turn", stSucceeded, "completed", nil, false},
		{"cancelled", "cancelled", stInterrupted, "interrupted", nil, false},
		{"max_tokens", "max_tokens", stFailed, "max_tokens", nil, false},
		{"refusal", "refusal", stFailed, "refusal", nil, false},
		{"missing_stop", "", stFailed, "error", nil, false},
		{"unknown_stop", "future_value", stFailed, "error", nil, false},
		{"rpc_error", "", stFailed, "error", errors.New("session/prompt: no API key"), false},
		{"unfinished_success", "end_turn", stFailed, "error", nil, true},
		{"unfinished_disconnect", "", stFailed, "error", errors.New("dsh acp closed"), true},
		{"unfinished_cancelled", "cancelled", stInterrupted, "interrupted", nil, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			var events []dshMappingEvent
			mapper := newDshEventMapper("session", func(turnID, kind string, payload map[string]interface{}) {
				events = append(events, dshMappingEvent{turnID, kind, payload})
			})
			if err := mapper.begin("turn"); err != nil {
				t.Fatal(err)
			}
			if err := mapper.update(dshMappingParams("session", "agent_message_chunk", map[string]interface{}{
				"messageId": "message", "content": map[string]interface{}{"type": "text", "text": "partial reply"},
			})); err != nil {
				t.Fatal(err)
			}
			if test.open {
				if err := mapper.update(dshMappingParams("session", "tool_call", map[string]interface{}{
					"toolCallId": "tool", "title": "write", "status": "in_progress",
				})); err != nil {
					t.Fatal(err)
				}
			}
			completion, settled := mapper.settle("turn", map[string]interface{}{"stopReason": test.stop}, test.err)
			if !settled || completion.Status != test.status || completion.Subtype != test.subtype || completion.Result != "partial reply" {
				t.Fatalf("completion = %+v settled=%v", completion, settled)
			}
			if _, twice := mapper.settle("turn", map[string]interface{}{"stopReason": "end_turn"}, nil); twice {
				t.Fatal("turn settled twice")
			}
			if len(dshMappingEventsOf(events, evTurnEnd)) != 1 || events[len(events)-1].kind != evTurnEnd {
				t.Fatalf("turn settlement order = %+v", events)
			}
			if test.open {
				results := dshMappingEventsOf(events, evToolResult)
				if len(results) != 1 || results[0].payload["isError"] != true || results[0].payload["toolCallId"] != "tool" ||
					!strings.Contains(results[0].payload["content"].(string), "side effects may have occurred") {
					t.Fatalf("unfinished tool = %+v", results)
				}
			}
			for _, event := range events {
				if _, ok := event.payload["contextTokens"]; ok {
					t.Fatal("unknown usage was presented as known")
				}
				if _, ok := event.payload["contextWindow"]; ok {
					t.Fatal("unknown window was presented as known")
				}
			}
		})
	}
}

func dshMappingParams(sessionID, kind string, fields map[string]interface{}) map[string]interface{} {
	fields["sessionUpdate"] = kind
	return map[string]interface{}{"sessionId": sessionID, "update": fields}
}

func TestDshACPEventAttribution(t *testing.T) {
	var events []dshMappingEvent
	mapper := newDshEventMapper("runtime", func(turnID, kind string, payload map[string]interface{}) {
		events = append(events, dshMappingEvent{turnID, kind, payload})
	})
	if err := mapper.begin("first"); err != nil {
		t.Fatal(err)
	}
	if err := mapper.begin("overlap"); err == nil {
		t.Fatal("allowed overlapping prompts")
	}
	block := dshMappingParams("runtime", "agent_message_chunk", map[string]interface{}{
		"messageId": "wire-message", "content": map[string]interface{}{"type": "text", "text": "first"},
	})
	if err := mapper.update(block); err != nil {
		t.Fatal(err)
	}
	if err := mapper.update(block); err != nil {
		t.Fatal(err)
	}
	if err := mapper.update(dshMappingParams("wrong-runtime", "agent_message_chunk", mapValue(block["update"]))); err == nil {
		t.Fatal("accepted an update for another runtime session")
	}
	tool := dshMappingParams("runtime", "tool_call", map[string]interface{}{"toolCallId": "wire-tool", "title": "read", "status": "in_progress"})
	terminal := dshMappingParams("runtime", "tool_call_update", map[string]interface{}{"toolCallId": "wire-tool", "status": "completed", "rawOutput": "done"})
	for _, update := range []map[string]interface{}{tool, tool, terminal, terminal} {
		if err := mapper.update(update); err != nil {
			t.Fatal(err)
		}
	}
	if _, settled := mapper.settle("wrong-local-turn", map[string]interface{}{"stopReason": "end_turn"}, nil); settled {
		t.Fatal("settled another local turn")
	}
	first, settled := mapper.settle("first", map[string]interface{}{"stopReason": "end_turn"}, nil)
	if !settled || first.Status != stSucceeded || first.Result != "first" {
		t.Fatalf("first completion = %+v", first)
	}
	if err := mapper.begin("first"); err == nil {
		t.Fatal("reopened an already settled turn")
	}
	before := len(events)
	if err := mapper.update(block); err != nil || len(events) != before {
		t.Fatalf("late content was attributed outside a turn: err=%v events=%+v", err, events)
	}
	if err := mapper.begin("second"); err != nil {
		t.Fatal(err)
	}
	before = len(events)
	if err := mapper.update(terminal); err != nil || len(events) != before {
		t.Fatalf("tool result from a preceding turn leaked into the new turn: err=%v", err)
	}
	if err := mapper.update(dshMappingParams("runtime", "tool_call_update", map[string]interface{}{"toolCallId": "never-opened", "status": "completed"})); err == nil {
		t.Fatal("accepted a terminal update for a tool no turn opened")
	}
	if err := mapper.update(dshMappingParams("runtime", "usage_update", map[string]interface{}{"used": 0, "size": 321})); err != nil {
		t.Fatal(err)
	}
	second, settled := mapper.settle("second", map[string]interface{}{"stopReason": "end_turn"}, nil)
	if !settled || second.Result != "" || second.Error != "" || second.Status != stSucceeded {
		t.Fatalf("preceding accumulator leaked: %+v", second)
	}
	if len(dshMappingEventsOf(events, evAssistant)) != 1 || len(dshMappingEventsOf(events, evToolUse)) != 1 || len(dshMappingEventsOf(events, evToolResult)) != 1 {
		t.Fatalf("duplicate content or tools: %+v", events)
	}
	for _, event := range events {
		if event.payload["runtimeSessionId"] != "runtime" || event.payload["localTurnId"] != event.turnID ||
			event.kind == evTextDelta || event.kind == evThinkingDelta {
			t.Fatalf("incorrect attribution or fabricated token delta: %+v", event)
		}
	}
	last := events[len(events)-1]
	if last.turnID != "second" || last.payload["contextTokens"] != 0 || last.payload["contextWindow"] != 321 {
		t.Fatalf("explicit zero usage was lost: %+v", last)
	}
}

// TestDshEventsToolCallJoin replays P0's recorded approval: dsh names the call by toolCallId only,
// after its tool_call. The mapper keeps what that call asked for, the bridge shows it on the card
// and answers with the exact wire shape the real CLI accepted; a settled call is no longer askable.
func TestDshEventsToolCallJoin(t *testing.T) {
	var rows []dshRecordedRow
	for _, row := range dshReadRecording(t) {
		if row.Scenario == "permission-allow-once" && row.Channel == "acp/out" {
			rows = append(rows, row)
		}
	}
	mapper := newDshEventMapper("<UUID_59>", func(string, string, map[string]interface{}) {})
	if err := mapper.begin("local-turn"); err != nil {
		t.Fatal(err)
	}
	policy, _ := dshPermissionPolicyFor("default")
	var asked []dshPermissionAsk
	var replies []map[string]interface{}
	bridge := newDshPermissionBridge(func() dshPermissionPolicy { return policy }, mapper.toolCall,
		func(_ context.Context, ask dshPermissionAsk) string { asked = append(asked, ask); return dshAllowOnce },
		func(string, string, map[string]interface{}) {})
	bridge.reply = func(id interface{}, outcome map[string]interface{}) error {
		replies = append(replies, map[string]interface{}{"jsonrpc": "2.0", "id": id, "result": map[string]interface{}{"outcome": outcome}})
		return nil
	}
	bridge.begin()
	requests := 0
	for _, row := range rows {
		switch row.Value["method"] {
		case "session/update":
			if err := mapper.update(mapValue(row.Value["params"])); err != nil {
				t.Fatalf("seq %d: %v", row.Seq, err)
			}
		case "session/request_permission":
			requests++
			params := mapValue(row.Value["params"])
			if call := mapValue(params["toolCall"]); len(call) != 1 || call["toolCallId"] != "call_p0_26" {
				t.Fatalf("recorded request = %+v", params)
			}
			bridge.request(row.Value["id"], params)
			bridge.wait()
		}
	}
	if requests != 1 || len(asked) != 1 || asked[0].Name != "write" || asked[0].ToolCallID != "call_p0_26" ||
		!strings.Contains(firstString(mapValue(asked[0].Input), "file_path"), "permission-allow-once.txt") {
		t.Fatalf("the card must carry the joined call: %+v", asked)
	}
	var recorded map[string]interface{}
	for _, row := range dshReadRecording(t) {
		if row.Scenario == "permission-allow-once" && row.Channel == "acp/in" && row.Value["result"] != nil && row.Value["id"] == float64(0) {
			recorded = row.Value
		}
	}
	got, _ := json.Marshal(replies[0])
	want, _ := json.Marshal(recorded)
	if len(replies) != 1 || string(got) != string(want) {
		t.Fatalf("reply %s, the real CLI accepted %s", got, want)
	}
	if _, ok := mapper.toolCall("call_p0_26"); ok {
		t.Fatal("a completed call can no longer be approved")
	}
	if _, ok := mapper.toolCall("call_p0_25"); ok {
		t.Fatal("a failed call can no longer be approved")
	}
}
