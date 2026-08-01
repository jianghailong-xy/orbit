package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestRuntimeProviderRecognizesKimi(t *testing.T) {
	job := &ClaimedSession{Provider: providerKimi}
	if got := runtimeProvider(job); got != providerKimi {
		t.Fatalf("runtimeProvider(kimi) = %q", got)
	}
	syncJobProvider(job)
	if job.RuntimeSessionID != "" {
		t.Fatalf("Kimi runtime id must be learned from ACP, got %q", job.RuntimeSessionID)
	}
	if got := currentRuntimeSessionID(job); got != "" {
		t.Fatalf("currentRuntimeSessionID before ACP init = %q", got)
	}
	job.RuntimeSessionID = "session_kimi"
	if got := currentRuntimeSessionID(job); got != "session_kimi" {
		t.Fatalf("currentRuntimeSessionID after ACP init = %q", got)
	}
}

func TestKimiModeForPermission(t *testing.T) {
	tests := map[string]string{
		"default":           "default",
		"acceptEdits":       "default",
		"plan":              "plan",
		"auto":              "auto",
		"dontAsk":           "default",
		"bypassPermissions": "yolo",
	}
	for input, want := range tests {
		if got := kimiModeForPermission(input); got != want {
			t.Errorf("kimiModeForPermission(%q) = %q, want %q", input, got, want)
		}
	}
}

type kimiTestWriteCloser struct{ bytes.Buffer }

func (w *kimiTestWriteCloser) Close() error { return nil }

type kimiBlockingWriteCloser struct {
	started chan struct{}
	release chan struct{}
	mu      sync.Mutex
	writes  [][]byte
}

func (w *kimiBlockingWriteCloser) Write(p []byte) (int, error) {
	w.started <- struct{}{}
	<-w.release
	copyOfP := append([]byte(nil), p...)
	w.mu.Lock()
	w.writes = append(w.writes, copyOfP)
	w.mu.Unlock()
	return len(p), nil
}

func (w *kimiBlockingWriteCloser) Close() error { return nil }

func TestKimiReadLoopAppliesNotificationsBeforeResponse(t *testing.T) {
	response := make(chan kimiRPCMessage, 1)
	app := &kimiACPClient{
		pending:       map[string]chan kimiRPCMessage{"prompt": response},
		notifications: make(chan kimiInboundItem, 8),
		done:          make(chan struct{}),
		permissions:   map[string]context.CancelFunc{},
	}
	processed := 0
	go func() {
		for {
			select {
			case item := <-app.notifications:
				if item.message != nil {
					processed++
				}
				if item.barrier != nil {
					close(item.barrier)
				}
			case <-app.done:
				return
			}
		}
	}()

	var wire strings.Builder
	const updates = 600 // exceeds the production channel buffer as a burst
	for i := 0; i < updates; i++ {
		fmt.Fprintf(&wire, "{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{\"n\":%d}}\n", i)
	}
	wire.WriteString("{\"jsonrpc\":\"2.0\",\"id\":\"prompt\",\"result\":{\"stopReason\":\"end_turn\"}}\n")
	go app.readLoop(strings.NewReader(wire.String()))

	select {
	case <-response:
		if processed != updates {
			t.Fatalf("response arrived after %d/%d notifications", processed, updates)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for ordered response")
	}
}

func TestKimiPermissionCancellationCancelsActiveAndLateRequests(t *testing.T) {
	started := make(chan struct{}, 2)
	cancelled := make(chan struct{}, 2)
	handled := make(chan struct{}, 2)
	out := &kimiTestWriteCloser{}
	app := &kimiACPClient{
		stdin:         out,
		done:          make(chan struct{}),
		pending:       map[string]chan kimiRPCMessage{},
		outWake:       make(chan struct{}, 1),
		permissions:   map[string]context.CancelFunc{},
		permissionCtx: context.Background(),
	}
	go app.writerLoop()
	defer app.closeDone()
	app.permission = func(ctx context.Context, _ map[string]interface{}) map[string]interface{} {
		started <- struct{}{}
		<-ctx.Done()
		cancelled <- struct{}{}
		return map[string]interface{}{"outcome": map[string]interface{}{"outcome": "cancelled"}}
	}
	app.beginPermissionTurn()
	activeGeneration := app.permissionGenerationSnapshot()
	go func() {
		app.handleServerRequest(kimiRPCMessage{ID: "p1", Method: "session/request_permission"}, activeGeneration)
		handled <- struct{}{}
	}()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("permission callback did not start")
	}
	app.cancelPermissions()
	select {
	case <-cancelled:
	case <-time.After(time.Second):
		t.Fatal("active permission was not cancelled")
	}
	select {
	case <-handled:
	case <-time.After(time.Second):
		t.Fatal("active permission handler did not finish")
	}

	// A request racing in after Stop is answered locally. It must never invoke the
	// callback, because that callback registers a visible control-plane approval.
	lateGeneration := app.permissionGenerationSnapshot()
	go func() {
		app.handleServerRequest(kimiRPCMessage{ID: "p2", Method: "session/request_permission"}, lateGeneration)
		handled <- struct{}{}
	}()
	select {
	case <-handled:
	case <-time.After(time.Second):
		t.Fatal("late permission handler did not finish")
	}
	select {
	case <-started:
		t.Fatal("late permission invoked the approval callback")
	default:
	}
	select {
	case <-cancelled:
		t.Fatal("late permission created a callback context")
	default:
	}
	var late map[string]interface{}
	for _, line := range strings.Split(strings.TrimSpace(out.String()), "\n") {
		var response map[string]interface{}
		if json.Unmarshal([]byte(line), &response) == nil && response["id"] == "p2" {
			late = response
		}
	}
	if outcome := firstString(mapValue(mapValue(late["result"])["outcome"]), "outcome"); outcome != "cancelled" {
		t.Fatalf("late permission outcome = %q, want cancelled", outcome)
	}
}

func TestKimiPermissionGenerationRejectsOldTurnAfterNewTurnOpens(t *testing.T) {
	out := &kimiTestWriteCloser{}
	app := &kimiACPClient{
		stdin:         out,
		done:          make(chan struct{}),
		pending:       map[string]chan kimiRPCMessage{},
		outWake:       make(chan struct{}, 1),
		permissions:   map[string]context.CancelFunc{},
		permissionCtx: context.Background(),
	}
	go app.writerLoop()
	defer app.closeDone()

	started := make(chan struct{}, 1)
	release := make(chan struct{})
	callbackCalls := 0
	app.permission = func(_ context.Context, _ map[string]interface{}) map[string]interface{} {
		callbackCalls++
		started <- struct{}{}
		<-release // deliberately ignore cancellation like an automatic allow can
		return map[string]interface{}{
			"outcome": map[string]interface{}{"outcome": "selected", "optionId": "approve_once"},
		}
	}

	app.beginPermissionTurn()
	oldGeneration := app.permissionGenerationSnapshot()
	handled := make(chan struct{})
	go func() {
		app.handleServerRequest(kimiRPCMessage{ID: "old-active", Method: "session/request_permission"}, oldGeneration)
		close(handled)
	}()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("old permission callback did not start")
	}
	app.cancelPermissions()
	app.beginPermissionTurn()
	close(release)
	select {
	case <-handled:
	case <-time.After(time.Second):
		t.Fatal("old permission callback did not finish")
	}

	// Simulate a reverse RPC read before Stop whose handler was not scheduled
	// until after the following turn had already opened.
	app.handleServerRequest(kimiRPCMessage{ID: "old-delayed", Method: "session/request_permission"}, oldGeneration)
	if callbackCalls != 1 {
		t.Fatalf("permission callback calls = %d, want only the originally active request", callbackCalls)
	}

	results := map[string]string{}
	for _, line := range strings.Split(strings.TrimSpace(out.String()), "\n") {
		var response map[string]interface{}
		if json.Unmarshal([]byte(line), &response) != nil {
			continue
		}
		id, _ := response["id"].(string)
		results[id] = firstString(mapValue(mapValue(response["result"])["outcome"]), "outcome")
	}
	for _, id := range []string{"old-active", "old-delayed"} {
		if results[id] != "cancelled" {
			t.Fatalf("permission response %s = %q, want cancelled", id, results[id])
		}
	}
}

func TestKimiWriterQueuesPromptAndCancelWithoutBlockingMainLoop(t *testing.T) {
	out := &kimiBlockingWriteCloser{started: make(chan struct{}, 2), release: make(chan struct{}, 2)}
	app := &kimiACPClient{
		stdin:         out,
		done:          make(chan struct{}),
		pending:       map[string]chan kimiRPCMessage{},
		outWake:       make(chan struct{}, 1),
		permissions:   map[string]context.CancelFunc{},
		permissionOff: true,
	}
	go app.writerLoop()
	defer app.closeDone()

	pending, promptAck, err := app.queueRequest("session/prompt", map[string]interface{}{
		"sessionId": "session-1",
		"prompt":    []map[string]interface{}{{"type": "text", "text": strings.Repeat("x", 1<<20)}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if pending == nil {
		t.Fatal("queueRequest returned no pending request")
	}
	select {
	case <-out.started:
	case <-time.After(time.Second):
		t.Fatal("writer did not start the prompt write")
	}

	// The writer is now blocked in the prompt's pipe Write. Enqueuing cancel
	// must still return immediately and remain ordered behind the prompt.
	cancelAck, err := app.queueNotify("session/cancel", map[string]interface{}{"sessionId": "session-1"})
	if err != nil {
		t.Fatal(err)
	}
	out.release <- struct{}{}
	if err := <-promptAck; err != nil {
		t.Fatal(err)
	}
	select {
	case <-out.started:
	case <-time.After(time.Second):
		t.Fatal("writer did not advance to cancel")
	}
	out.release <- struct{}{}
	if err := <-cancelAck; err != nil {
		t.Fatal(err)
	}

	out.mu.Lock()
	writes := append([][]byte(nil), out.writes...)
	out.mu.Unlock()
	if len(writes) != 2 {
		t.Fatalf("wire writes = %d, want prompt + cancel", len(writes))
	}
	methods := make([]string, 0, len(writes))
	for _, wire := range writes {
		var message map[string]interface{}
		if err := json.Unmarshal(bytes.TrimSpace(wire), &message); err != nil {
			t.Fatal(err)
		}
		methods = append(methods, firstString(message, "method"))
	}
	if !reflect.DeepEqual(methods, []string{"session/prompt", "session/cancel"}) {
		t.Fatalf("wire methods = %v, want prompt then cancel", methods)
	}
}

func TestKimiUsesEnvModelRequiresCompleteOverride(t *testing.T) {
	if !kimiUsesEnvModel(map[string]string{
		"KIMI_MODEL_NAME": "kimi-for-coding", "KIMI_MODEL_API_KEY": "sk-test",
	}) {
		t.Fatal("complete environment model override was not recognized")
	}
	if kimiUsesEnvModel(map[string]string{"KIMI_MODEL_API_KEY": "sk-test"}) {
		t.Fatal("API key alone must not activate Kimi's environment model")
	}
}

func TestKimiMCPServersConvertsACPShapes(t *testing.T) {
	agent := AgentExecConfig{McpConfig: map[string]interface{}{
		"stdio": map[string]interface{}{
			"command": "node",
			"args":    []interface{}{"server.js", "--stdio"},
			"env":     map[string]interface{}{"TOKEN": "x"},
		},
		"remote": map[string]interface{}{
			"type":    "sse",
			"url":     "https://example.test/sse",
			"headers": map[string]interface{}{"Authorization": "Bearer x"},
		},
	}}
	got := kimiMCPServers(agent, "/opt/orbit")
	if len(got) != 3 {
		t.Fatalf("servers = %#v", got)
	}
	if got[0]["name"] != "remote" || got[0]["type"] != "sse" {
		t.Fatalf("remote server = %#v", got[0])
	}
	if got[1]["name"] != "stdio" || got[1]["command"] != "node" {
		t.Fatalf("stdio server = %#v", got[1])
	}
	if !reflect.DeepEqual(got[1]["args"], []string{"server.js", "--stdio"}) {
		t.Fatalf("stdio args = %#v", got[1]["args"])
	}
	if got[2]["name"] != "orbit" || got[2]["command"] != "/opt/orbit" {
		t.Fatalf("orbit server = %#v", got[2])
	}
}

func kimiNotification(t *testing.T, sessionID string, update map[string]interface{}) kimiRPCMessage {
	t.Helper()
	b, err := json.Marshal(map[string]interface{}{"sessionId": sessionID, "update": update})
	if err != nil {
		t.Fatal(err)
	}
	return kimiRPCMessage{Method: "session/update", Params: b}
}

func TestHandleKimiNotificationMapsTranscriptEvents(t *testing.T) {
	type event struct {
		typ     string
		payload map[string]interface{}
	}
	var events []event
	emit := func(typ string, payload map[string]interface{}) {
		events = append(events, event{typ: typ, payload: payload})
	}
	active := &kimiActiveTurn{
		orbitTurnID: "turn-1",
		seenTools:   map[string]bool{},
		doneTools:   map[string]bool{},
	}
	var mu sync.Mutex
	updates := []map[string]interface{}{
		{
			"sessionUpdate": "agent_thought_chunk",
			"content":       map[string]interface{}{"type": "text", "text": "think"},
		},
		{
			"sessionUpdate": "agent_message_chunk",
			"content":       map[string]interface{}{"type": "text", "text": "hello"},
		},
		{
			"sessionUpdate": "tool_call",
			"toolCallId":    "1:tool-a",
			"title":         "Read",
			"rawInput":      map[string]interface{}{"path": "a.txt"},
		},
		{
			"sessionUpdate": "tool_call_update",
			"toolCallId":    "1:tool-a",
			"status":        "completed",
			"rawOutput":     "contents",
		},
	}
	for _, update := range updates {
		handleKimiNotification("session-1", kimiNotification(t, "session-1", update), emit, &mu, &active)
	}
	if len(events) != 4 {
		t.Fatalf("events = %#v", events)
	}
	if events[0].typ != evThinkingDelta || events[1].typ != evTextDelta ||
		events[2].typ != evToolUse || events[3].typ != evToolResult {
		t.Fatalf("event types = %#v", events)
	}
	if active.thought.String() != "think" || active.text.String() != "hello" {
		t.Fatalf("active buffers = thought %q text %q", active.thought.String(), active.text.String())
	}
	if events[3].payload["content"] != "contents" || events[3].payload["isError"] != false {
		t.Fatalf("tool result = %#v", events[3].payload)
	}
	// Terminal tool updates are replace-style and can be repeated by an ACP
	// transport retry; Orbit must persist exactly one result.
	handleKimiNotification("session-1", kimiNotification(t, "session-1", updates[3]), emit, &mu, &active)
	if len(events) != 4 {
		t.Fatalf("duplicate terminal update emitted another event: %#v", events)
	}
}

func TestKimiPermissionOptionMapsApprovalAndQuestion(t *testing.T) {
	options := []interface{}{
		map[string]interface{}{"optionId": "approve_once", "name": "Approve once", "kind": "allow_once"},
		map[string]interface{}{"optionId": "approve_always", "name": "Approve always", "kind": "allow_always"},
		map[string]interface{}{"optionId": "reject", "name": "Reject", "kind": "reject_once"},
	}
	if got := kimiPermissionOption(options, &ApprovalDecisionResponse{Status: "ALLOWED"}, ""); got != "approve_once" {
		t.Fatalf("allow once = %q", got)
	}
	if got := kimiPermissionOption(options, &ApprovalDecisionResponse{
		Status:        "ALLOWED",
		RememberRules: []PermissionRule{{ToolName: "Bash"}},
	}, ""); got != "approve_always" {
		t.Fatalf("allow always = %q", got)
	}
	if got := kimiPermissionOption(options, &ApprovalDecisionResponse{Status: "DENIED"}, ""); got != "reject" {
		t.Fatalf("reject = %q", got)
	}

	questionOptions := []interface{}{
		map[string]interface{}{"optionId": "q0_opt_0", "name": "Vanilla", "kind": "allow_once"},
		map[string]interface{}{"optionId": "q0_opt_1", "name": "Chocolate", "kind": "allow_once"},
		map[string]interface{}{"optionId": "q0_skip", "name": "Skip", "kind": "reject_once"},
	}
	decision := &ApprovalDecisionResponse{Status: "ALLOWED", Answers: map[string][]string{"Flavor?": {"Chocolate"}}}
	if got := kimiPermissionOption(questionOptions, decision, "Flavor?"); got != "q0_opt_1" {
		t.Fatalf("question answer = %q", got)
	}
}

func TestKimiAutomaticPermissionPolicyIsFailClosed(t *testing.T) {
	options := []interface{}{
		map[string]interface{}{"optionId": "approve_once", "kind": "allow_once"},
		map[string]interface{}{"optionId": "reject", "kind": "reject_once"},
	}
	job := &ClaimedSession{Agent: AgentExecConfig{
		PermissionMode: "dontAsk",
		AllowedTools:   []string{"mcp__orbit__*", "Bash(/opt/orbit task list *)"},
	}}
	if got, decided := kimiAutomaticPermissionOption(job, "Bash", map[string]interface{}{"command": "rm -rf /tmp/x"}, options, ""); got != "reject" || !decided {
		t.Fatalf("unmatched Don't Ask tool = %q, %t; want reject, true", got, decided)
	}
	if got, decided := kimiAutomaticPermissionOption(job, "mcp__orbit__task_list", nil, options, ""); got != "approve_once" || !decided {
		t.Fatalf("allowed MCP tool = %q, %t; want approve_once, true", got, decided)
	}
	for _, command := range []string{
		"/opt/orbit task list --json",
		"/opt/orbit task list --json; touch /tmp/pwn",
		"/opt/orbit task list --json && touch /tmp/pwn",
		"/opt/orbit task list --json | sh",
		"/opt/orbit task list --json > /tmp/pwn",
		"/opt/orbit task list --json $(touch /tmp/pwn)",
	} {
		if got, decided := kimiAutomaticPermissionOption(job, "Bash", map[string]interface{}{"command": command}, options, ""); got != "reject" || !decided {
			t.Fatalf("shell subject %q = %q, %t; want reject, true", command, got, decided)
		}
	}
	if got, decided := kimiAutomaticPermissionOption(job, "AskUserQuestion", nil, options, "Choose?"); got != "" || decided {
		t.Fatalf("question should reach the user, got automatic option %q, %t", got, decided)
	}
	if got, decided := kimiAutomaticPermissionOption(job, "UnknownTool", nil, nil, ""); got != "" || !decided {
		t.Fatalf("Don't Ask without a reject option = %q, %t; want fail-closed decision", got, decided)
	}
	if got := kimiToolPolicyError(AgentExecConfig{DisallowedTools: []string{"Read"}}); got == "" {
		t.Fatal("Kimi must reject a denylist it cannot enforce before execution")
	}
}

func TestKimiPlanReviewBecomesStructuredQuestion(t *testing.T) {
	toolCall := map[string]interface{}{
		"content": []interface{}{map[string]interface{}{
			"content": map[string]interface{}{"type": "text", "text": "Choose a plan"},
		}},
	}
	options := []interface{}{
		map[string]interface{}{"optionId": "plan_opt_0", "name": "Fast"},
		map[string]interface{}{"optionId": "plan_opt_1", "name": "Safe"},
		map[string]interface{}{"optionId": "plan_revise", "name": "Revise"},
		map[string]interface{}{"optionId": "plan_reject_and_exit", "name": "Reject and Exit"},
	}
	question, got := kimiQuestionFromPermission(toolCall, options)
	if question != "Choose a plan" {
		t.Fatalf("question = %q", question)
	}
	want := []map[string]interface{}{{"label": "Fast"}, {"label": "Safe"}, {"label": "Revise"}, {"label": "Reject and Exit"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("plan options = %#v, want %#v", got, want)
	}
	decision := &ApprovalDecisionResponse{Status: "ALLOWED", Answers: map[string][]string{question: {"Safe"}}}
	if selected := kimiPermissionOption(options, decision, question); selected != "plan_opt_1" {
		t.Fatalf("selected plan option = %q", selected)
	}
}

func TestKimiPromptCarriesAgentAndOrbitInstructions(t *testing.T) {
	agent := AgentExecConfig{SystemPrompt: "Review carefully", AppendSystemPrompt: "Keep it short"}
	got := kimiPromptText(agent, "/opt/orbit", "hello")
	for _, want := range []string{"<orbit-agent-instructions>", "Review carefully", "Keep it short", "/opt/orbit", "hello"} {
		if !strings.Contains(got, want) {
			t.Fatalf("prompt %q missing %q", got, want)
		}
	}
}

func TestRunnerEnginePathIncludesKimiInstallerDirectory(t *testing.T) {
	got := runnerEnginePath("/home/alice", "/usr/bin")
	for _, want := range []string{"/home/alice/.local/bin", "/usr/bin"} {
		if !pathContains(got, want) {
			t.Fatalf("runnerEnginePath = %q, missing %q", got, want)
		}
	}
	if pathContains(got, "/home/alice/.kimi-code/bin") {
		t.Fatalf("runnerEnginePath must not expose Kimi's managed rg/fd directory: %q", got)
	}
	if twice := runnerEnginePath("/home/alice", got); twice != got {
		t.Fatalf("runnerEnginePath is not idempotent: %q -> %q", got, twice)
	}
}
