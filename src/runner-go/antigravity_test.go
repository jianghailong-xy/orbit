package main

import (
	"bufio"
	"context"
	"encoding/json"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"
)

// ── The recorded agy 1.2.15 samples (testdata/antigravity), replayed through the event mapping ──────

type agyRecorded struct {
	kind    string
	payload map[string]interface{}
}

// agyReplay feeds a sample's stdout through the session loop's event handling, with its stderr fed
// first (so an AGY_ERROR line is in hand by the result, the worst case for the fallback text), and
// returns the transcript and the turn completions. Every user_input step opens the next turn, the
// way a written message does.
func agyReplay(t *testing.T, sample string, configure func(*agyDriver)) ([]agyRecorded, []TurnCompleteRequest) {
	t.Helper()
	dir := filepath.Join("testdata", "antigravity", sample)
	var events []agyRecorded
	var completions []TurnCompleteRequest
	scratch := t.TempDir()
	d := &agyDriver{
		job:        &ClaimedSession{SessionID: "sample-session", Provider: providerAntigravity, Agent: AgentExecConfig{Provider: providerAntigravity}},
		execDir:    scratch,
		scratchDir: scratch,
		emit: func(kind string, payload map[string]interface{}) {
			events = append(events, agyRecorded{kind: kind, payload: payload})
		},
		setTurn: func(string) {},
		completeTurn: func(req TurnCompleteRequest, _ ...context.Context) error {
			completions = append(completions, req)
			return nil
		},
		proc: &agyProcess{},
	}
	if configure != nil {
		configure(d)
	}
	if stderr, err := os.ReadFile(filepath.Join(dir, "stderr.txt")); err == nil {
		w := &agyStderrWriter{proc: d.proc, emit: d.emit}
		_, _ = w.Write(stderr)
		w.flush()
	}
	f, err := os.Open(filepath.Join(dir, "stdout.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 1024*1024), 16*1024*1024)
	turns := 0
	for sc.Scan() {
		var event map[string]interface{}
		if err := json.Unmarshal(sc.Bytes(), &event); err != nil {
			t.Fatal(err)
		}
		if step := mapValue(event["step_update"]); step != nil && step["step_type"] == "user_input" && d.turn == nil {
			turns++
			d.turn = newAgyTurn("t" + string(rune('0'+turns)))
		}
		d.handleEvent(event)
	}
	return events, completions
}

func agyKinds(events []agyRecorded, kind string) []map[string]interface{} {
	var out []map[string]interface{}
	for _, e := range events {
		if e.kind == kind {
			out = append(out, e.payload)
		}
	}
	return out
}

func TestAntigravityTwoTurnsFromTheRecordedSample(t *testing.T) {
	events, completions := agyReplay(t, "text-multiturn", nil)
	if len(completions) != 2 {
		t.Fatalf("completions = %+v", completions)
	}
	for i, want := range []string{"Hello! This answer is streamed in several chunks, so the CLI emits ACTIVE text deltas before the DONE step.", "Second turn, one chunk."} {
		got := completions[i]
		if got.Status != stSucceeded || got.Subtype != "success" || got.Result != want || got.NumTurns != 1 {
			t.Fatalf("turn %d = %+v", i+1, got)
		}
		if got.RuntimeSessionID != "eed8d1e5-62e3-440a-aa97-ca41050b27f4" {
			t.Fatalf("turn %d conversation = %q", i+1, got.RuntimeSessionID)
		}
	}
	// Per-turn usage, not agy's running total for the conversation.
	if u := completions[1].Usage; u == nil || u.InputTokens != 14299 || u.OutputTokens != 6 {
		t.Fatalf("turn 2 usage = %+v", u)
	}
	if got := len(agyKinds(events, evTextDelta)); got != 8 {
		t.Fatalf("text deltas = %d, want every chunk of both turns", got)
	}
	assistant := agyKinds(events, evAssistant)
	if len(assistant) != 2 || assistant[0]["text"] != "Hello! This answer is streamed in several chunks, so the CLI emits ACTIVE text deltas before the DONE step.\n" {
		t.Fatalf("assistant = %v", assistant)
	}
	// No thinking: agy never streams it (§2.2).
	if len(agyKinds(events, evThinking))+len(agyKinds(events, evThinkingDelta)) != 0 {
		t.Fatal("thinking events from a stream that has no thinking text")
	}
	var inits []map[string]interface{}
	for _, e := range agyKinds(events, evSystem) {
		if e["subtype"] == "init" {
			inits = append(inits, e)
		}
	}
	if len(inits) != 1 || inits[0]["provider"] != providerAntigravity || inits[0]["sessionId"] != "eed8d1e5-62e3-440a-aa97-ca41050b27f4" {
		t.Fatalf("init events = %v", inits)
	}
	if acks := agyKinds(events, evUserDelivery); len(acks) != 2 || acks[0]["delivery"] != string(deliveryAcknowledged) {
		t.Fatalf("user deliveries = %v", acks)
	}
}

func TestAntigravityToolStepsFromTheRecordedSample(t *testing.T) {
	events, completions := agyReplay(t, "tools-skip-permissions", nil)
	if len(completions) != 1 || completions[0].Status != stSucceeded || completions[0].Result != "all done" {
		t.Fatalf("completions = %+v", completions)
	}
	conv := "7dccd4b6-d728-4a7b-8125-6544ffd180d9:"
	wantUses := []map[string]interface{}{
		{"id": conv + "2", "name": "Bash", "input": map[string]interface{}{"command": "echo hi-from-tool && pwd"}},
		{"id": conv + "4", "name": "Write", "input": map[string]interface{}{"file_path": "/work/repo/made.txt"}},
		{"id": conv + "6", "name": "Edit", "input": map[string]interface{}{"file_path": "/work/repo/existing.txt"}},
		{"id": conv + "8", "name": "Read", "input": map[string]interface{}{"file_path": "/work/repo/made.txt"}},
		{"id": conv + "10", "name": "Bash", "input": map[string]interface{}{"command": "ls /nonexistent-dir-xyz"}},
		{"id": conv + "12", "name": "no_such_tool", "input": map[string]interface{}{"x": float64(1)}},
	}
	if uses := agyKinds(events, evToolUse); !reflect.DeepEqual(uses, wantUses) {
		t.Fatalf("tool uses =\n%v\nwant\n%v", uses, wantUses)
	}
	wantResults := []map[string]interface{}{
		{"toolUseId": conv + "2", "content": "hi-from-tool\r\n/work/repo\r\n", "isError": false},
		// A write prints nothing; it is sent once the model goes on.
		{"toolUseId": conv + "4", "content": "", "isError": false},
		{"toolUseId": conv + "6", "content": "", "isError": false},
		{"toolUseId": conv + "8", "content": "2 lines, 5 bytes", "isError": false},
		// A failing command is still DONE: agy reports no exit code (§2.2).
		{"toolUseId": conv + "10", "content": "ls: cannot access '/nonexistent-dir-xyz': No such file or directory\r\n", "isError": false},
		{"toolUseId": conv + "12", "content": `unknown tool: "no_such_tool" — check spelling`, "isError": true},
	}
	if results := agyKinds(events, evToolResult); !reflect.DeepEqual(results, wantResults) {
		t.Fatalf("tool results =\n%v\nwant\n%v", results, wantResults)
	}
}

func TestAntigravityMCPCallFromTheRecordedSample(t *testing.T) {
	events, completions := agyReplay(t, "mcp-call", nil)
	if len(completions) != 1 || completions[0].Status != stSucceeded {
		t.Fatalf("completions = %+v", completions)
	}
	uses := agyKinds(events, evToolUse)
	if len(uses) != 1 || uses[0]["name"] != "mcp__orbit__whoami" || !reflect.DeepEqual(uses[0]["input"], map[string]interface{}{"note": "hello"}) {
		t.Fatalf("tool use = %v", uses)
	}
	if results := agyKinds(events, evToolResult); len(results) != 1 || results[0]["content"] != "session=sample-session note=hello" {
		t.Fatalf("tool result = %v", results)
	}
}

// §5.2: a refusal ends the turn right after the tool, with an empty response. denied_actions is the
// conversation's whole set, so the third turn — denied_actions still listed — is an ordinary answer.
func TestAntigravitySoftDenialFromTheRecordedSample(t *testing.T) {
	events, completions := agyReplay(t, "denied-default", nil)
	if len(completions) != 3 {
		t.Fatalf("completions = %+v", completions)
	}
	for i, permission := range []string{"command", "write_file"} {
		got := completions[i]
		if got.Status != stFailed || got.Subtype != "permission_denied" || !strings.Contains(got.Error, `"`+permission+`"`) {
			t.Fatalf("turn %d = %+v", i+1, got)
		}
	}
	if got := completions[2]; got.Status != stSucceeded || got.Result != "plain answer still works" {
		t.Fatalf("turn 3 = %+v", got)
	}
	results := agyKinds(events, evToolResult)
	if len(results) != 2 {
		t.Fatalf("tool results = %v", results)
	}
	for _, r := range results {
		if r["isError"] != true || !strings.HasPrefix(asString(r["content"]), "Not run: ") {
			t.Fatalf("a refused tool's result = %v", r)
		}
	}
	if errs := agyKinds(events, evError); len(errs) != 2 {
		t.Fatalf("errors = %v", errs)
	}
	// agy's own advice is about a settings file the user does not manage: it is not shown.
	for _, e := range agyKinds(events, evSystem) {
		if strings.Contains(asString(e["stderr"]), "jetski") {
			t.Fatalf("stderr shown: %v", e)
		}
	}
}

// The other shape a refusal takes (§5.2, seen on 1.2.16 under load): the tool step ends ERROR with
// agy's own "permission check failed … user denied permission", and the turn still ends right there.
func TestAntigravitySoftDenialWithAgysOwnError(t *testing.T) {
	var events []agyRecorded
	var completions []TurnCompleteRequest
	d := &agyDriver{
		job:     &ClaimedSession{SessionID: "s"},
		emit:    func(kind string, payload map[string]interface{}) { events = append(events, agyRecorded{kind, payload}) },
		setTurn: func(string) {},
		completeTurn: func(req TurnCompleteRequest, _ ...context.Context) error {
			completions = append(completions, req)
			return nil
		},
		proc: &agyProcess{initialized: true},
		turn: newAgyTurn("t1"),
	}
	denial := `permission check failed for command "touch x": user denied permission to run command: touch x`
	for _, event := range []map[string]interface{}{
		{"event": "step_update", "step_update": map[string]interface{}{"conversation_id": "c", "step_index": 0.0, "state": "DONE", "step_type": "user_input"}},
		{"event": "step_update", "step_update": map[string]interface{}{"conversation_id": "c", "step_index": 1.0, "state": "DONE", "step_type": "agent_response"}},
		{"event": "step_update", "step_update": map[string]interface{}{"conversation_id": "c", "step_index": 2.0, "state": "ACTIVE", "step_type": "tool",
			"tool_info": map[string]interface{}{"name": "run_command", "parameters": map[string]interface{}{"CommandLine": "touch x"}}}},
		{"event": "step_update", "step_update": map[string]interface{}{"conversation_id": "c", "step_index": 2.0, "state": "ERROR", "step_type": "tool",
			"tool_info": map[string]interface{}{"name": "run_command", "error": map[string]interface{}{"type": "TOOL_ERROR", "message": denial}}}},
		{"event": "result", "result": map[string]interface{}{"conversation_id": "c", "status": "SUCCESS", "response": "",
			"denied_actions": []interface{}{map[string]interface{}{"action": "command", "display_name": "RunCommand"}}}},
	} {
		d.handleEvent(event)
	}
	if len(completions) != 1 || completions[0].Status != stFailed || completions[0].Subtype != "permission_denied" {
		t.Fatalf("completions = %+v", completions)
	}
	if results := agyKinds(events, evToolResult); len(results) != 1 || results[0]["content"] != denial || results[0]["isError"] != true {
		t.Fatalf("tool results = %v, want agy's own denial, once", results)
	}
}

// §2.4: a real error fails the turn with agy's reason, and a rejected key reads as a sign-in failure.
func TestAntigravityModelErrorFromTheRecordedSample(t *testing.T) {
	events, completions := agyReplay(t, "error-invalid-key", nil)
	if len(completions) != 1 {
		t.Fatalf("completions = %+v", completions)
	}
	got := completions[0]
	if got.Status != stFailed || got.Subtype != "error" || !strings.HasPrefix(got.Error, "Failed to authenticate: ") || !strings.Contains(got.Error, "API key not valid") {
		t.Fatalf("turn = %+v", got)
	}
	if errs := agyKinds(events, evError); len(errs) != 1 || errs[0]["message"] != got.Error {
		t.Fatalf("errors = %v", errs)
	}
	for _, e := range agyKinds(events, evSystem) {
		if e["stderr"] != nil {
			t.Fatalf("an error already reported was shown again from stderr: %v", e)
		}
	}

	_, completions = agyReplay(t, "error-quota-429", nil)
	if got := completions[0]; got.Status != stFailed || !strings.Contains(got.Error, "RESOURCE_EXHAUSTED") || isAuthError(got.Error) {
		t.Fatalf("quota turn = %+v", got)
	}
}

// §2.4: once a conversation has hit an error, agy reports every later result as ERROR with that old
// error. Those turns answered normally and must not fail.
func TestAntigravityStickyErrorStatusIsNotAFailure(t *testing.T) {
	_, completions := agyReplay(t, filepath.Join("resume-after-error", "2-resumed-process"), func(d *agyDriver) {
		d.proc.requested = "678b5e2b-72a3-47af-aec0-6c2b3ba521c0"
	})
	if len(completions) != 2 {
		t.Fatalf("completions = %+v", completions)
	}
	for i, want := range []string{"A ok", "B ok"} {
		if got := completions[i]; got.Status != stSucceeded || got.Result != want || got.Error != "" {
			t.Fatalf("turn %d = %+v", i+1, got)
		}
	}
}

// An interrupt agy reports itself ends the turn INTERRUPTED, with what had streamed as its result.
func TestAntigravityInterruptedFromTheRecordedSample(t *testing.T) {
	_, completions := agyReplay(t, "interrupt-sigint-streaming", nil)
	if len(completions) != 1 || completions[0].Status != stInterrupted || completions[0].Subtype != "interrupted" {
		t.Fatalf("completions = %+v", completions)
	}
}

// The command agy was running when it was interrupted never reaches DONE (§4.1): its call is
// answered as interrupted, before the turn ends, rather than left running.
func TestAntigravityInterruptedToolFromTheRecordedSample(t *testing.T) {
	events, completions := agyReplay(t, "interrupt-sigint-tool", nil)
	if len(completions) != 1 || completions[0].Status != stInterrupted {
		t.Fatalf("completions = %+v", completions)
	}
	id := "5728f00b-909c-46fd-b62d-5311c5a158e1:2"
	if uses := agyKinds(events, evToolUse); len(uses) != 1 || uses[0]["id"] != id {
		t.Fatalf("tool uses = %v", uses)
	}
	want := []map[string]interface{}{{"toolUseId": id, "content": "Interrupted: the turn was stopped while this tool was running.", "isError": true}}
	if results := agyKinds(events, evToolResult); !reflect.DeepEqual(results, want) {
		t.Fatalf("tool results = %v, want %v", results, want)
	}
	if kinds := agyEventKinds(events); strings.Index(kinds, evToolResult) > strings.Index(kinds, evTurnEnd) {
		t.Fatalf("the result came after the turn ended: %s", kinds)
	}
}

// agy gone mid-tool: the turn fails with how it exited, and the call it was running is answered.
func TestAntigravityToolOpenWhenAgyExitsIsAnswered(t *testing.T) {
	var events []agyRecorded
	var completions []TurnCompleteRequest
	d := &agyDriver{
		job:     &ClaimedSession{SessionID: "s", Provider: providerAntigravity},
		emit:    func(kind string, payload map[string]interface{}) { events = append(events, agyRecorded{kind, payload}) },
		setTurn: func(string) {},
		completeTurn: func(req TurnCompleteRequest, _ ...context.Context) error {
			completions = append(completions, req)
			return nil
		},
		proc: &agyProcess{initialized: true},
		turn: newAgyTurn("t1"),
	}
	// Numbers as JSON decodes them.
	for _, index := range []float64{2, 3} {
		d.handleEvent(map[string]interface{}{"event": "step_update", "step_update": map[string]interface{}{
			"conversation_id": "c", "step_index": index, "state": "ACTIVE", "step_type": "tool",
			"tool_info": map[string]interface{}{"name": "run_command", "parameters": map[string]interface{}{"CommandLine": "sleep 60"}},
		}})
	}
	d.handleEvent(map[string]interface{}{"event": "step_update", "step_update": map[string]interface{}{
		"conversation_id": "c", "step_index": float64(3), "state": "DONE", "step_type": "tool",
		"tool_info": map[string]interface{}{"name": "run_command", "output": "done early"},
	}})
	d.processExited()
	if len(completions) != 1 || completions[0].Status != stFailed || !strings.Contains(completions[0].Error, "before finishing the turn") {
		t.Fatalf("completions = %+v", completions)
	}
	want := []map[string]interface{}{
		{"toolUseId": "c:3", "content": "done early", "isError": false},
		{"toolUseId": "c:2", "content": "Interrupted: the turn failed while this tool was running.", "isError": true},
	}
	if results := agyKinds(events, evToolResult); !reflect.DeepEqual(results, want) {
		t.Fatalf("tool results = %v, want %v", results, want)
	}
}

func agyEventKinds(events []agyRecorded) string {
	kinds := make([]string, len(events))
	for i, e := range events {
		kinds[i] = e.kind
	}
	return strings.Join(kinds, " ")
}

// §4.3: --conversation naming an id agy cannot find starts a new conversation, said only on stderr.
func TestAntigravityLostConversationIsReported(t *testing.T) {
	var job *ClaimedSession
	events, completions := agyReplay(t, "unknown-conversation", func(d *agyDriver) {
		d.proc.requested = "00000000-1111-2222-3333-444444444444"
		d.job.RuntimeSessionID = d.proc.requested
		job = d.job
	})
	if job.RuntimeSessionID != "1672cd2a-6291-480b-a481-98e27c73f9f2" || completions[0].RuntimeSessionID != job.RuntimeSessionID {
		t.Fatalf("the session kept %q", job.RuntimeSessionID)
	}
	notices := 0
	for _, e := range agyKinds(events, evSystem) {
		if e["noticeKind"] == "antigravity-conversation-lost" {
			notices++
		}
	}
	if notices != 1 {
		t.Fatalf("notices = %d", notices)
	}
}

func TestAntigravityStartupFailureFailsTheTurn(t *testing.T) {
	var completions []TurnCompleteRequest
	d := &agyDriver{
		job:     &ClaimedSession{SessionID: "s", Agent: AgentExecConfig{Model: "gemini-3.1-pro", Effort: "medium"}},
		emit:    func(string, map[string]interface{}) {},
		setTurn: func(string) {},
		completeTurn: func(req TurnCompleteRequest, _ ...context.Context) error {
			completions = append(completions, req)
			return nil
		},
		proc: &agyProcess{},
		turn: newAgyTurn("t1"),
	}
	// What agy 1.2.16 prints for a level the model does not have, before any init.
	d.handleEvent(map[string]interface{}{"event": "result", "result": map[string]interface{}{
		"conversation_id": "", "status": "ERROR", "response": "",
		"error": `invalid model selection (--model "gemini-3.1-pro" --effort "medium"): gemini-3.1-pro has no "medium" effort (available: low, high)`,
	}})
	if len(completions) != 1 || completions[0].Status != stFailed || !strings.Contains(completions[0].Error, "invalid model selection") {
		t.Fatalf("completions = %+v", completions)
	}
}

func TestAntigravityStderrKeepsWhatTheLoopDoesNotSay(t *testing.T) {
	var shown []string
	p := &agyProcess{}
	w := &agyStderrWriter{proc: p, emit: func(kind string, payload map[string]interface{}) {
		shown = append(shown, asString(payload["stderr"]))
	}}
	_, _ = w.Write([]byte("error: interrupted\nAGY_ERROR: {\"short_error\":\"quota\",\"status\":\"RESOURCE_EXHAUSTED\",\"error_code\":429,\"retryable\":true}\n" +
		"jetski: no output produced — a tool required the \"command\" permission\nwarning: conversation \"x\" not found\nsomething else entirely\npartial"))
	w.flush()
	if !reflect.DeepEqual(shown, []string{"something else entirely\n", "partial\n"}) {
		t.Fatalf("shown = %q", shown)
	}
	if report, _ := p.errorReport(); report == nil || report.Status != "RESOURCE_EXHAUSTED" || report.ErrorCode != 429 || !report.Retryable {
		t.Fatalf("AGY_ERROR = %+v", report)
	}
}

// ── Models ──────────────────────────────────────────────────────────────────────────────────────

// `agy models` on 1.2.15 and 1.2.16 (contract §9.1).
const agyModelsOutput = "gemini-3.8-flash-high\tGemini 3.8 Flash (High)\ngemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)\n" +
	"gemini-3.8-flash-low\tGemini 3.8 Flash (Low)\ngemini-3.7-flash-high\tGemini 3.7 Flash (High)\n" +
	"gemini-3.7-flash-medium\tGemini 3.7 Flash (Medium)\ngemini-3.7-flash-low\tGemini 3.7 Flash (Low)\n" +
	"gemini-3.6-flash-high\tGemini 3.6 Flash (High)\ngemini-3.6-flash-medium\tGemini 3.6 Flash (Medium)\n" +
	"gemini-3.6-flash-low\tGemini 3.6 Flash (Low)\ngemini-3.1-pro-high\tGemini 3.1 Pro (High)\ngemini-3.1-pro-low\tGemini 3.1 Pro (Low)\n"

func TestAntigravityModelCatalogFoldsLevelsIntoModels(t *testing.T) {
	models := parseAntigravityModels([]byte("Fetching available models...\n" + agyModelsOutput))
	want := []ModelInfo{
		{Value: "gemini-3.8-flash", Label: "Gemini 3.8 Flash", ContextWindow: 1_048_576, ReasoningLevels: []string{"low", "medium", "high"}, DefaultReasoningLevel: "high"},
		{Value: "gemini-3.7-flash", Label: "Gemini 3.7 Flash", ContextWindow: 1_048_576, ReasoningLevels: []string{"low", "medium", "high"}, DefaultReasoningLevel: "high"},
		{Value: "gemini-3.6-flash", Label: "Gemini 3.6 Flash", ContextWindow: 1_048_576, ReasoningLevels: []string{"low", "medium", "high"}, DefaultReasoningLevel: "high"},
		{Value: "gemini-3.1-pro", Label: "Gemini 3.1 Pro", ContextWindow: 1_048_576, ReasoningLevels: []string{"low", "high"}, DefaultReasoningLevel: "high"},
	}
	if !reflect.DeepEqual(models, want) {
		t.Fatalf("models =\n%+v\nwant\n%+v", models, want)
	}
	// A model the window table has not met is no reading, not a guess.
	if got := parseAntigravityModels([]byte("gemini-9-ultra-high\tGemini 9 Ultra (High)\n")); len(got) != 1 || got[0].ContextWindow != 0 {
		t.Fatalf("unknown model = %+v", got)
	}
}

func TestAntigravityModelArgs(t *testing.T) {
	catalog := parseAntigravityModels([]byte(agyModelsOutput))
	for _, tc := range []struct {
		model, effort string
		catalog       []ModelInfo
		want          []string
	}{
		{"", "high", catalog, nil}, // agy's own default, effort included
		{"gemini-3.8-flash", "medium", catalog, []string{"--model", "gemini-3.8-flash", "--effort", "medium"}},
		{"gemini-3.8-flash", "", catalog, []string{"--model", "gemini-3.8-flash", "--effort", "high"}},
		// A level the model lacks would stop agy from starting: the model's default instead.
		{"gemini-3.1-pro", "medium", catalog, []string{"--model", "gemini-3.1-pro", "--effort", "high"}},
		{"gemini-3.8-flash-low", "", catalog, []string{"--model", "gemini-3.8-flash", "--effort", "low"}},
		{"gemini-3.8-flash-low", "high", catalog, []string{"--model", "gemini-3.8-flash", "--effort", "high"}},
		// Not in the catalog (none yet, or newer than it): as given, for agy to answer.
		{"gemini-4-argon", "", nil, []string{"--model", "gemini-4-argon"}},
		{"gemini-4-argon", "max", nil, []string{"--model", "gemini-4-argon", "--effort", "max"}},
		{"gemini-4-argon-high", "", nil, []string{"--model", "gemini-4-argon-high"}},
	} {
		if got := antigravityModelArgs(tc.model, tc.effort, tc.catalog); !reflect.DeepEqual(got, tc.want) {
			t.Errorf("antigravityModelArgs(%q, %q) = %q, want %q", tc.model, tc.effort, got, tc.want)
		}
	}
}

func TestAntigravityContextWindowFollowsTheCatalogAndTheTable(t *testing.T) {
	publishModelCatalog(&ModelCatalog{Antigravity: []ModelInfo{{Value: "gemini-3.8-flash", ContextWindow: 2_000_000}}})
	t.Cleanup(func() { publishModelCatalog(nil) })
	for model, want := range map[string]int{
		"gemini-3.8-flash":      2_000_000, // the catalog the runner published
		"gemini-3.8-flash-high": 1_048_576, // a full slug is no catalog row: the table
		"":                      1_048_576, // agy's default model
		"gemini-9-ultra":        0,
	} {
		job := &ClaimedSession{Provider: providerAntigravity, Agent: AgentExecConfig{Model: model}}
		got, _ := withAntigravityContextWindow(map[string]interface{}{}, job)["contextWindow"].(int)
		if got != want {
			t.Errorf("window for %q = %d, want %d", model, got, want)
		}
	}
}

// ── Permissions ─────────────────────────────────────────────────────────────────────────────────

func TestAntigravityPermissionModeFlags(t *testing.T) {
	skip := []string{"--dangerously-skip-permissions"}
	for mode, want := range map[string][2][]string{
		// mode: {without a confirmed approval gate, with one}
		"":                  {nil, nil},
		"default":           {nil, skip},
		"dontAsk":           {nil, nil},
		"acceptEdits":       {{"--mode", "accept-edits"}, skip},
		"plan":              {{"--mode", "plan"}, {"--mode", "plan"}},
		"auto":              {skip, skip},
		"bypassPermissions": {skip, skip},
	} {
		for i, gated := range []bool{false, true} {
			if got := antigravityPermissionArgs(mode, gated); !reflect.DeepEqual(got, want[i]) {
				t.Errorf("%q (gated %v) -> %q, want %q", mode, gated, got, want[i])
			}
		}
	}
	// The modes that ask are the ones the gate is for; without it they keep agy's own refusal.
	for mode, asks := range map[string]bool{"default": true, "acceptEdits": true, "": false, "dontAsk": false, "plan": false, "auto": false, "bypassPermissions": false} {
		if got := antigravityAsksForApproval(mode); got != asks {
			t.Errorf("antigravityAsksForApproval(%q) = %v, want %v", mode, got, asks)
		}
	}
}

func TestAntigravityPermissionRulesTranslateOrbitsRules(t *testing.T) {
	job := &ClaimedSession{Agent: AgentExecConfig{
		PermissionMode: "default",
		AllowedTools: []string{
			"mcp__orbit__*", "Bash(git commit:*)", "Bash(npm test)", "Read(/repo/docs)", "Edit",
			"WebFetch(domain:go.dev)", "mcp__docs__search", "mcp__fs", "Glob",
		},
		DisallowedTools: []string{"Bash(rm:*)", "Bash(git push)", "Read(.env)", "Write(/repo/secret.txt)"},
	}}
	allow, deny := antigravityPermissionRules(job, "")
	wantAllow := []string{
		"mcp(orbit/*)", "command(git commit)", "read_file(/repo/docs)", "write_file(*)", "read_url(go.dev)",
		"mcp(docs/search)", "mcp(fs/*)",
	}
	if !reflect.DeepEqual(allow, wantAllow) {
		t.Fatalf("allow = %q, want %q (an exact command is never widened to a prefix)", allow, wantAllow)
	}
	wantDeny := []string{"command(rm)", "command(git push)", "read_file(*)", "write_file(/repo/secret.txt)"}
	if !reflect.DeepEqual(deny, wantDeny) {
		t.Fatalf("deny = %q, want %q (a deny agy might not match denies the whole permission)", deny, wantDeny)
	}

	job.Agent.PermissionMode = "plan"
	if allow, deny := antigravityPermissionRules(job, ""); !reflect.DeepEqual(allow, []string{"mcp(orbit/*)"}) || len(deny) != 4 {
		t.Fatalf("plan: allow %q deny %q", allow, deny)
	}
	job.Agent.PermissionMode = "bypassPermissions"
	if allow, deny := antigravityPermissionRules(job, ""); allow != nil || len(deny) != 4 {
		t.Fatalf("bypass: allow %q deny %q — deny rules hold even when everything else is skipped", allow, deny)
	}

	// Orbit's own CLI is pre-approved as a command prefix, like claude's Bash rules for it.
	job.Agent.PermissionMode = "acceptEdits"
	allow, _ = antigravityPermissionRules(job, "/opt/orbit/bin/orbit")
	if !contains(allow, "command(/opt/orbit/bin/orbit task list)") {
		t.Fatalf("allow = %q, want the orbit CLI's task commands", allow)
	}
}

// ── The private Gemini directory ────────────────────────────────────────────────────────────────

func TestAntigravityGeminiDirIsTheSessionsOwn(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	orbitHome := t.TempDir()
	t.Setenv("ORBIT_HOME", orbitHome)
	scratch := t.TempDir()
	job := &ClaimedSession{
		SessionID: "s1",
		TaskID:    "task-1",
		Agent: AgentExecConfig{
			PermissionMode:     "default",
			AppendSystemPrompt: "Answer in haiku.",
			AllowedTools:       []string{"mcp__orbit__*"},
			McpConfig: map[string]interface{}{
				"docs":   map[string]interface{}{"command": "docs-mcp", "args": []interface{}{"--stdio"}, "env": map[string]interface{}{"TOKEN": "x"}},
				"remote": map[string]interface{}{"url": "https://mcp.example.com"},
				"orbit":  map[string]interface{}{"command": "not-orbit"},
			},
		},
	}
	dir, err := prepareAntigravityGeminiDir(scratch, job, "/opt/orbit/bin/orbit", false)
	if err != nil {
		t.Fatal(err)
	}
	if want, _ := filepath.Abs(filepath.Join(scratch, "antigravity")); dir != want {
		t.Fatalf("dir = %q", dir)
	}
	var settings map[string]interface{}
	readJSONFile(t, filepath.Join(dir, "antigravity-cli", "settings.json"), &settings)
	if settings["modelProvider"] != "gemini" || settings["enableTelemetry"] != false {
		t.Fatalf("settings = %v", settings)
	}
	if allow, _ := mapValue(settings["permissions"])["allow"].([]interface{}); len(allow) == 0 || allow[0] != "mcp(orbit/*)" {
		t.Fatalf("permissions = %v", settings["permissions"])
	}
	var mcp struct {
		MCPServers map[string]map[string]interface{} `json:"mcpServers"`
	}
	readJSONFile(t, filepath.Join(dir, "config", "mcp_config.json"), &mcp)
	if len(mcp.MCPServers) != 2 || mcp.MCPServers["orbit"]["command"] != "/opt/orbit/bin/orbit" ||
		!reflect.DeepEqual(mcp.MCPServers["orbit"]["args"], []interface{}{"mcp"}) || mcp.MCPServers["docs"]["command"] != "docs-mcp" {
		t.Fatalf("mcpServers = %v (Orbit's own server wins its name; a remote server is not passed)", mcp.MCPServers)
	}
	rules, err := os.ReadFile(filepath.Join(dir, "GEMINI.md"))
	if err != nil || !strings.HasPrefix(string(rules), "Answer in haiku.") || !strings.Contains(string(rules), "call_mcp_tool") ||
		strings.Contains(string(rules), "mcp__orbit__*") {
		t.Fatalf("GEMINI.md = %q (%v)", rules, err)
	}
	if target, err := os.Readlink(filepath.Join(dir, "antigravity-cli", "bin")); err != nil || target != filepath.Join(orbitHome, "antigravity", "bin") {
		t.Fatalf("bin -> %q (%v), want the runner-wide directory", target, err)
	}
	if runtime.GOOS != "windows" {
		if info, _ := os.Stat(dir); info.Mode().Perm() != 0o700 {
			t.Fatalf("dir mode = %v", info.Mode().Perm())
		}
	}

	// A reload rewrites Orbit's files and leaves agy's own alone.
	if err := os.WriteFile(filepath.Join(dir, "config", "hooks.json"), []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	job.Agent.PermissionMode = "bypassPermissions"
	job.Agent.AppendSystemPrompt = ""
	job.Agent.SystemPrompt = ""
	// No orbit executable to describe, and nothing configured: nothing to say.
	if _, err := prepareAntigravityGeminiDir(scratch, job, "", false); err != nil {
		t.Fatal(err)
	}
	settings = nil
	readJSONFile(t, filepath.Join(dir, "antigravity-cli", "settings.json"), &settings)
	if _, ok := settings["permissions"]; ok {
		t.Fatalf("bypass settings = %v", settings)
	}
	if _, err := os.Stat(filepath.Join(dir, "GEMINI.md")); !os.IsNotExist(err) {
		t.Fatalf("GEMINI.md with nothing to say: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "config", "hooks.json")); err != nil {
		t.Fatal("a file Orbit does not own was removed")
	}
	var written []string
	_ = filepath.WalkDir(home, func(path string, _ fs.DirEntry, err error) error {
		if err == nil && path != home {
			written = append(written, path)
		}
		return nil
	})
	if len(written) > 0 {
		t.Fatalf("written under HOME: %v", written)
	}
}

func readJSONFile(t *testing.T, path string, v interface{}) {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, v); err != nil {
		t.Fatalf("%s: %v", path, err)
	}
}

// §3.5: agy runs a checkout's .agents hooks and MCP servers in every mode.
func TestAntigravityRefusesACheckoutThatBringsItsOwnHooksOrMCP(t *testing.T) {
	repo := t.TempDir()
	if err := os.Mkdir(filepath.Join(repo, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	sub := filepath.Join(repo, "pkg", "sub")
	if err := os.MkdirAll(filepath.Join(sub, ".agents", "skills"), 0o755); err != nil {
		t.Fatal(err)
	}
	// Skills alone are instructions, not commands.
	if err := guardAntigravityProjectConfig(sub, "default"); err != nil {
		t.Fatalf("skills only: %v", err)
	}
	for _, at := range []string{
		filepath.Join(repo, ".agents", "mcp_config.json"),
		filepath.Join(sub, ".agents", "hooks.json"),
		filepath.Join(repo, "pkg", ".agents", "plugins.json"),
		filepath.Join(sub, ".agents", "plugins"),
	} {
		if err := os.MkdirAll(filepath.Dir(at), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(at, []byte("{}"), 0o644); err != nil {
			t.Fatal(err)
		}
		for _, mode := range []string{"default", "acceptEdits", "plan", "dontAsk"} {
			if err := guardAntigravityProjectConfig(sub, mode); err == nil || !strings.Contains(err.Error(), at) {
				t.Fatalf("%s in %s mode: %v", at, mode, err)
			}
		}
		for _, mode := range []string{"auto", "bypassPermissions"} {
			if err := guardAntigravityProjectConfig(sub, mode); err != nil {
				t.Fatalf("%s mode refused: %v", mode, err)
			}
		}
		_ = os.Remove(at)
	}
	// Above the repository root is somebody else's directory.
	if err := os.MkdirAll(filepath.Join(filepath.Dir(repo), ".agents"), 0o755); err == nil {
		defer os.RemoveAll(filepath.Join(filepath.Dir(repo), ".agents"))
		_ = os.WriteFile(filepath.Join(filepath.Dir(repo), ".agents", "hooks.json"), []byte("{}"), 0o644)
		if err := guardAntigravityProjectConfig(sub, "default"); err != nil {
			t.Fatalf("a .agents above the repository counted: %v", err)
		}
	}
}

// ── The process ─────────────────────────────────────────────────────────────────────────────────

func TestAntigravityArgsAndEnv(t *testing.T) {
	job := &ClaimedSession{
		SessionID: "s1", RuntimeSessionID: "conv-1",
		Agent: AgentExecConfig{Model: "gemini-3.8-flash", Effort: "low", PermissionMode: "acceptEdits", Env: map[string]string{"GEMINI_API_KEY": "k"}},
	}
	got := antigravityArgs(job, "/scratch/antigravity", false)
	want := []string{
		"--gemini_dir=/scratch/antigravity", "--print=", "--input-format", "stream-json", "--output-format", "stream-json",
		"--disable-slash-commands", "--print-timeout=0s", "--conversation", "conv-1",
		"--model", "gemini-3.8-flash", "--effort", "low", "--mode", "accept-edits",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("args =\n%q\nwant\n%q", got, want)
	}
	t.Setenv("HOME", "/home/someone")
	env := antigravityEnv(job, "/work")
	for _, pair := range []string{"AGY_CLI_DISABLE_AUTO_UPDATE=true", "GEMINI_API_KEY=k", "ORBIT_SESSION_ID=s1", "PWD=/work", "HOME=/home/someone", envMCPPermissionPrompt + "=0"} {
		if !contains(env, pair) {
			t.Errorf("env lacks %s", pair)
		}
	}
}

func TestAntigravityEngineWiring(t *testing.T) {
	if got := runtimeProvider(&ClaimedSession{Provider: "Antigravity"}); got != providerAntigravity {
		t.Fatalf("runtimeProvider = %q", got)
	}
	rt := providerRuntimeFor(providerAntigravity)
	if rt.transport != transportStreamJSON || rt.steersMidTurn || rt.steerCapability != "" {
		t.Fatalf("runtime = %+v", rt)
	}
	if !contains(strings.Split(runnerSupportedProviders, ","), providerAntigravity) {
		t.Fatalf("supported providers %q", runnerSupportedProviders)
	}
	spec, ok := specFor(providerAntigravity)
	if !ok || spec.executable() != "agy" || spec.updateCmd == "" || spec.apiKeyEnv != "GEMINI_API_KEY" ||
		!strings.Contains(spec.installCmd, "antigravity.google/cli/install.sh") || !strings.HasSuffix(spec.latestURL, runtime.GOOS+"_"+runtime.GOARCH+".json") {
		t.Fatalf("spec = %+v", spec)
	}
	if !strings.HasPrefix(spec.updateCmd, "agy --gemini_dir=") || !strings.HasSuffix(spec.updateCmd, " update") {
		t.Fatalf("updateCmd = %q: the updater's state must stay out of ~/.gemini", spec.updateCmd)
	}
	if !hasInjectedCredentials(providerAntigravity, map[string]string{"GEMINI_API_KEY": "k"}) ||
		hasInjectedCredentials(providerAntigravity, map[string]string{"GEMINI_API_KEY": " "}) ||
		hasInjectedCredentials(providerAntigravity, map[string]string{"ANTHROPIC_API_KEY": "k"}) {
		t.Fatal("hasInjectedCredentials does not key on GEMINI_API_KEY")
	}
	if flow := loginFlowFor(providerAntigravity); flow.engine != providerAntigravity || !flow.pty || !flow.takesCode || len(flow.argv) != 1 || flow.argv[0] != agyExecutable {
		t.Fatalf("login flow = %+v, want Google OAuth over a PTY", flow)
	}
	t.Setenv("ORBIT_HOME", t.TempDir())
	ctx := context.Background()
	if got := probeAuthIn(ctx, providerAntigravity, "/nonexistent/agy", []string{"GEMINI_API_KEY=k"}); got != authYes {
		t.Fatalf("with a key: %v", got)
	}
	if got := probeAuthIn(ctx, providerAntigravity, "/nonexistent/agy", []string{"HOME=/x"}); got != authNo {
		t.Fatalf("without a key: %v", got)
	}
	if msg := engineSignedOutMessage(providerAntigravity); !isAuthError(msg) || !strings.Contains(msg, "GEMINI_API_KEY") {
		t.Fatalf("signed out = %q", msg)
	}
	publishModelCatalog(&ModelCatalog{Antigravity: []ModelInfo{{Value: "gemini-3.8-flash", ContextWindow: 7}}})
	t.Cleanup(func() { publishModelCatalog(nil) })
	if got := modelContextWindow(providerAntigravity, "gemini-3.8-flash"); got != 7 {
		t.Fatalf("modelContextWindow = %d", got)
	}
	merged := carryOverModelCatalog(&ModelCatalog{Antigravity: []ModelInfo{{Value: "a"}}}, &ModelCatalog{Claude: []ModelInfo{{Value: "c"}}})
	if len(merged.Antigravity) != 1 {
		t.Fatalf("a failed agy refresh dropped the last good list: %+v", merged)
	}
}

// An on-demand install is not refused for the runner having no key of its own: the key comes with
// the session, and engineAuthPreflight checks it with the session's environment.
func TestAntigravityFreshInstallLeavesTheKeyToThePreflight(t *testing.T) {
	dir := t.TempDir()
	// Not "agy": the one this machine may have installed would be found before any install ran.
	target := filepath.Join(dir, "orbit-fake-agy")
	saved := engineSpecs
	engineSpecs = []engineSpec{{
		name: "Antigravity", bin: providerAntigravity, exe: "orbit-fake-agy", apiKeyEnv: "GEMINI_API_KEY", installAlt: "-",
		installCmd: "printf '#!/bin/sh\\nexit 0\\n' > " + target + " && chmod +x " + target,
	}}
	t.Cleanup(func() { engineSpecs = saved })
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("GEMINI_API_KEY", "")
	configureEngineInstall(true, nil)
	t.Cleanup(func() { configureEngineInstall(false, nil) })

	if msg := ensureEngine(context.Background(), providerAntigravity, func(string) {}); msg != "" {
		t.Fatalf("fresh install = %q", msg)
	}
	if _, err := os.Stat(target); err != nil {
		t.Fatal("the installer never ran")
	}
	if msg := engineAuthPreflight(providerAntigravity, map[string]string{"GEMINI_API_KEY": "k"}); msg != "" {
		t.Fatalf("a session with its own key was refused: %q", msg)
	}
	if msg := engineAuthPreflight(providerAntigravity, nil); !isAuthError(msg) || !strings.Contains(msg, "GEMINI_API_KEY") {
		t.Fatalf("a session with no key anywhere = %q", msg)
	}
}

func TestAntigravityLoginRelayUsesGoogleOAuth(t *testing.T) {
	const url = "https://accounts.google.com/o/oauth2/auth?state=fixture"
	flow := loginFlowFor(providerAntigravity)
	got := flow.progress("\x1b]8;;" + url + "\x07Click here to authenticate\x1b]8;;\x07\nauthorization code...")
	if got == nil || got.Status != loginAwaitingCode || got.URL != url || !flow.pty || !flow.takesCode {
		t.Fatalf("login flow did not relay Google OAuth: %+v", got)
	}
}

// ── The session loop, against a stand-in agy ────────────────────────────────────────────────────

// fakeAgy is a stand-in for agy that speaks just enough stream-json: an init, then for every stdin
// line a user_input step, a reply and a result. It logs its argv and each line it reads, and holds
// its first turn open until AGY_FAKE_HOLD exists.
const fakeAgy = `printf '%s\n' "$*" >> "$AGY_FAKE_DIR/argv"
echo '{"event":"init","conversation_id":"fake-conv","init":{"cwd":"x","tools":[],"permission_mode":"request-review"}}'
n=0
while IFS= read -r line; do
  n=$((n+1))
  printf '%s\n' "$line" >> "$AGY_FAKE_DIR/stdin"
  echo '{"event":"step_update","step_update":{"conversation_id":"fake-conv","step_index":1,"state":"DONE","step_type":"user_input"}}'
  if [ "$n" = 1 ]; then while [ ! -f "$AGY_FAKE_DIR/release" ]; do sleep 0.02; done; fi
  echo '{"event":"step_update","step_update":{"conversation_id":"fake-conv","step_index":2,"state":"DONE","step_type":"agent_response","text_delta":"reply","usage":{"input_tokens":10,"output_tokens":2,"cache_read_tokens":0,"total_tokens":12}}}'
  echo '{"event":"result","result":{"conversation_id":"fake-conv","status":"SUCCESS","response":"reply","num_turns":1}}'
done`

type fakeAgySession struct {
	dir         string
	inbox       chan RunInboxResponse
	completions chan TurnCompleteRequest
	done        chan struct{}
}

func startFakeAgySession(t *testing.T, job *ClaimedSession) *fakeAgySession {
	t.Helper()
	bin := t.TempDir()
	writeFakeBin(t, bin, agyExecutable, fakeAgy)
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("ORBIT_HOME", t.TempDir())
	f := &fakeAgySession{
		dir:         t.TempDir(),
		inbox:       make(chan RunInboxResponse, 8),
		completions: make(chan TurnCompleteRequest, 8),
		done:        make(chan struct{}),
	}
	if job.Agent.Env == nil {
		job.Agent.Env = map[string]string{}
	}
	job.Agent.Env["AGY_FAKE_DIR"] = f.dir
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/inbox") {
			http.NotFound(w, r)
			return
		}
		select {
		case resp := <-f.inbox:
			_ = json.NewEncoder(w).Encode(resp)
		case <-time.After(10 * time.Second):
			_, _ = w.Write([]byte(`{}`))
		case <-r.Context().Done():
		}
	}))
	t.Cleanup(srv.Close)
	ctx, cancel := context.WithCancel(context.Background())
	scratch := t.TempDir()
	go func() {
		defer close(f.done)
		runAntigravitySessionProcess(ctx, context.Background(), NewTransport(srv.URL, "token"), job, "", scratch, scratch,
			func(string, map[string]interface{}) {}, func(string, string, map[string]interface{}) {}, func(string) {}, false, nil,
			func(req TurnCompleteRequest, _ ...context.Context) error { f.completions <- req; return nil },
			func(context.Context) bool { return true }, func(error) {})
	}()
	t.Cleanup(func() {
		cancel()
		<-f.done
	})
	return f
}

func (f *fakeAgySession) lines(t *testing.T, name string) []string {
	t.Helper()
	raw, _ := os.ReadFile(filepath.Join(f.dir, name))
	return strings.Split(strings.TrimSpace(string(raw)), "\n")
}

func (f *fakeAgySession) waitLines(t *testing.T, name string, n int) []string {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		raw, _ := os.ReadFile(filepath.Join(f.dir, name))
		if text := strings.TrimSpace(string(raw)); text != "" && len(strings.Split(text, "\n")) >= n {
			return strings.Split(text, "\n")
		}
		if time.Now().After(deadline) {
			t.Fatalf("%s never reached %d lines: %q", name, n, raw)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func (f *fakeAgySession) completion(t *testing.T) TurnCompleteRequest {
	t.Helper()
	select {
	case req := <-f.completions:
		return req
	case <-time.After(10 * time.Second):
		t.Fatal("no turn completed")
	}
	return TurnCompleteRequest{}
}

// §8: a message that arrives while a turn runs is Orbit's to queue, written only after the turn's
// `result` — agy would queue it too, but a queued line dies with the process when the turn is
// interrupted. A steer is refused: nothing can join a running turn.
func TestAntigravityHoldsAMidTurnMessageUntilTheTurnEnds(t *testing.T) {
	f := startFakeAgySession(t, &ClaimedSession{SessionID: "s-queue", Provider: providerAntigravity})
	f.inbox <- RunInboxResponse{TurnID: "t1", Kind: "message", Content: "first"}
	f.waitLines(t, "stdin", 1)
	f.inbox <- RunInboxResponse{TurnID: "t2", Kind: "message", Content: "second"}
	f.inbox <- RunInboxResponse{TurnID: "s1", Kind: "steer", Content: "join in"}
	if steer := f.completion(t); steer.TurnID != "s1" || steer.Status != stFailed || steer.Subtype != subtypeSteer {
		t.Fatalf("steer = %+v", steer)
	}
	time.Sleep(200 * time.Millisecond)
	if got := f.lines(t, "stdin"); len(got) != 1 {
		t.Fatalf("written while the first turn ran: %q", got)
	}
	if err := os.WriteFile(filepath.Join(f.dir, "release"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"t1", "t2"} {
		if got := f.completion(t); got.TurnID != want || got.Status != stSucceeded || got.RuntimeSessionID != "fake-conv" {
			t.Fatalf("completion = %+v, want %s", got, want)
		}
	}
	lines := f.waitLines(t, "stdin", 2)
	var frame struct {
		Event   string `json:"event"`
		Message struct {
			Content string `json:"content"`
		} `json:"message"`
	}
	if err := json.Unmarshal([]byte(lines[1]), &frame); err != nil || frame.Event != "user" || frame.Message.Content != "second" {
		t.Fatalf("second frame = %q (%v)", lines[1], err)
	}
	if argv := f.lines(t, "argv"); len(argv) != 1 {
		t.Fatalf("agy started %d times, want once: %q", len(argv), argv)
	}
}

// A reload's model and permission mode are agy flags: the next turn runs in a new agy that has them,
// on the same conversation. (Don't Ask rather than Default to start from: Default starts agy only
// behind Orbit's approval hook, which this stand-in cannot list.)
func TestAntigravityReloadStartsTheNextTurnWithTheNewFlags(t *testing.T) {
	f := startFakeAgySession(t, &ClaimedSession{SessionID: "s-reload", Provider: providerAntigravity, Agent: AgentExecConfig{PermissionMode: "dontAsk"}})
	if err := os.WriteFile(filepath.Join(f.dir, "release"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	f.inbox <- RunInboxResponse{TurnID: "t1", Kind: "message", Content: "first"}
	if got := f.completion(t); got.TurnID != "t1" || got.Status != stSucceeded {
		t.Fatalf("t1 = %+v", got)
	}
	f.inbox <- RunInboxResponse{TurnID: "r1", Kind: "reload", Content: `{"permissionMode":"bypassPermissions","model":"gemini-3.8-flash","effort":"low"}`}
	f.inbox <- RunInboxResponse{TurnID: "t2", Kind: "message", Content: "second"}
	if got := f.completion(t); got.TurnID != "t2" || got.Status != stSucceeded {
		t.Fatalf("t2 = %+v", got)
	}
	argv := f.waitLines(t, "argv", 2)
	if strings.Contains(argv[0], "--dangerously-skip-permissions") || strings.Contains(argv[0], "--conversation") {
		t.Fatalf("first agy = %q", argv[0])
	}
	for _, flag := range []string{"--conversation fake-conv", "--model gemini-3.8-flash --effort low", "--dangerously-skip-permissions"} {
		if !strings.Contains(argv[1], flag) {
			t.Fatalf("agy after the reload = %q, lacks %q", argv[1], flag)
		}
	}
}
