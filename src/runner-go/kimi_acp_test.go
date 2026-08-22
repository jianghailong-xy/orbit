package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
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

// kimiSetConfigCall is one `session/set_config_option` the client put on the wire.
type kimiSetConfigCall struct{ configID, value string }

// runKimiConfigureSession drives configureSession against a scripted ACP peer:
// the peer answers every set_config_option with reject(configID, value), or with
// an empty result when that returns nil. `advertised` stands in for the thinking
// levels the handshake described. It reports the calls in wire order.
func runKimiConfigureSession(
	t *testing.T,
	agent AgentExecConfig,
	advertised []string,
	reject func(configID, value string) *kimiRPCError,
) ([]kimiSetConfigCall, error) {
	t.Helper()
	return runKimiConfigureSessionWithResults(t, agent, advertised, reject, nil)
}

// runKimiConfigureSessionWithResults is runKimiConfigureSession with a peer that can
// answer an accepted call with a real result body — how the CLI re-describes its
// pickers when the model changes — instead of an empty object.
func runKimiConfigureSessionWithResults(
	t *testing.T,
	agent AgentExecConfig,
	advertised []string,
	reject func(configID, value string) *kimiRPCError,
	result func(configID, value string) json.RawMessage,
) ([]kimiSetConfigCall, error) {
	t.Helper()
	peerReads, clientWrites := io.Pipe()
	clientReads, peerWrites := io.Pipe()
	app := &kimiACPClient{
		stdin:           clientWrites,
		done:            make(chan struct{}),
		pending:         map[string]chan kimiRPCMessage{},
		outWake:         make(chan struct{}, 1),
		notifications:   make(chan kimiInboundItem, 8),
		permissions:     map[string]context.CancelFunc{},
		permissionOff:   true,
		thinkingOptions: advertised,
	}
	go app.writerLoop()
	go app.readLoop(clientReads)
	defer app.closeDone()
	// readLoop holds every response behind a notification barrier, so the session
	// loop's consumer has to exist for a response to reach its waiter at all.
	go func() {
		for {
			select {
			case item := <-app.notifications:
				if item.barrier != nil {
					close(item.barrier)
				}
			case <-app.done:
				return
			}
		}
	}()

	var (
		mu    sync.Mutex
		calls []kimiSetConfigCall
	)
	go func() {
		defer peerWrites.Close()
		sc := bufio.NewScanner(peerReads)
		for sc.Scan() {
			var request kimiRPCMessage
			if err := json.Unmarshal(sc.Bytes(), &request); err != nil {
				return
			}
			var params struct{ ConfigID, Value string }
			_ = json.Unmarshal(request.Params, &params)
			mu.Lock()
			calls = append(calls, kimiSetConfigCall{params.ConfigID, params.Value})
			mu.Unlock()
			body := json.RawMessage(`{}`)
			if result != nil {
				if scripted := result(params.ConfigID, params.Value); scripted != nil {
					body = scripted
				}
			}
			response := kimiRPCMessage{ID: request.ID, Result: body}
			if failure := reject(params.ConfigID, params.Value); failure != nil {
				response = kimiRPCMessage{ID: request.ID, Error: failure}
			}
			wire, err := json.Marshal(response)
			if err != nil {
				return
			}
			if _, err := peerWrites.Write(append(wire, '\n')); err != nil {
				return
			}
		}
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	err := app.configureSession(ctx, "session-1", agent)
	mu.Lock()
	defer mu.Unlock()
	return append([]kimiSetConfigCall(nil), calls...), err
}

// A KIMI_MODEL_* provider's synthesized alias declares no support_efforts, so
// its picker offers nothing but off/on. Orbit must not send a level anyway: the
// rejection is printed to the CLI's stderr, and Orbit renders engine stderr as a
// failure, so a session that recovered still reads as broken in the transcript.
func TestKimiEffortClampedToAdvertisedLevels(t *testing.T) {
	calls, err := runKimiConfigureSession(t,
		AgentExecConfig{Effort: "max", PermissionMode: "default"},
		[]string{"off", "on"},
		func(configID, value string) *kimiRPCError {
			if configID != "thinking" || value == "off" || value == "on" {
				return nil
			}
			return &kimiRPCError{
				Code:    -32602,
				Message: `Invalid params: Unknown thinking effort for model "__kimi_env_model__": ` + value,
			}
		})
	if err != nil {
		t.Fatal(err)
	}
	want := []kimiSetConfigCall{{"thinking", "on"}, {"mode", "default"}}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("config calls = %v, want %v — max must never reach the wire", calls, want)
	}
}

// The handshake describes the session's *current* model. Selecting another one
// re-describes the thinking picker, so the levels captured at session/new are the
// previous model's: K3 declares low/high/max where the default K2.7 Coding declares
// none, and clamping against the stale list would silently flatten Max to the model
// default.
func TestKimiEffortClampedAgainstTheSelectedModel(t *testing.T) {
	calls, err := runKimiConfigureSessionWithResults(t,
		AgentExecConfig{Model: "kimi-code/k3", Effort: "max", PermissionMode: "default"},
		[]string{"on"},
		func(string, string) *kimiRPCError { return nil },
		func(configID, value string) json.RawMessage {
			if configID != "model" {
				return nil
			}
			return json.RawMessage(`{"configOptions":[{"id":"thinking","options":[
				{"value":"low"},{"value":"high"},{"value":"max"}]}]}`)
		})
	if err != nil {
		t.Fatal(err)
	}
	want := []kimiSetConfigCall{
		{"model", "kimi-code/k3"}, {"thinking", "max"}, {"mode", "default"},
	}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("config calls = %v, want %v", calls, want)
	}
}

// …and the other direction: a model that declares no levels of its own must clamp a
// carried-over one, even when the handshake's model did declare it.
func TestKimiEffortClampedWhenSelectedModelDeclaresNoLevels(t *testing.T) {
	calls, err := runKimiConfigureSessionWithResults(t,
		AgentExecConfig{Model: "kimi-code/kimi-for-coding", Effort: "max", PermissionMode: "default"},
		[]string{"low", "high", "max"},
		func(string, string) *kimiRPCError { return nil },
		func(configID, value string) json.RawMessage {
			if configID != "model" {
				return nil
			}
			return json.RawMessage(`{"configOptions":[{"id":"thinking","options":[{"value":"on"}]}]}`)
		})
	if err != nil {
		t.Fatal(err)
	}
	want := []kimiSetConfigCall{
		{"model", "kimi-code/kimi-for-coding"}, {"thinking", "on"}, {"mode", "default"},
	}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("config calls = %v, want %v", calls, want)
	}
}

// Clamping may not flatten a level the model does actually declare.
func TestKimiAdvertisedEffortIsSentUnchanged(t *testing.T) {
	calls, err := runKimiConfigureSession(t,
		AgentExecConfig{Effort: "high", PermissionMode: "default"},
		[]string{"off", "on", "low", "medium", "high"},
		func(string, string) *kimiRPCError { return nil })
	if err != nil {
		t.Fatal(err)
	}
	want := []kimiSetConfigCall{{"thinking", "high"}, {"mode", "default"}}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("config calls = %v, want %v", calls, want)
	}
}

// A handshake that described no picker leaves the level unknown, not forbidden.
// The request goes through, and a rejection is absorbed rather than failing the
// session before its first turn.
func TestKimiUnadvertisedEffortFallsBackToModelDefault(t *testing.T) {
	calls, err := runKimiConfigureSession(t,
		AgentExecConfig{Effort: "max", PermissionMode: "default"},
		nil,
		func(configID, value string) *kimiRPCError {
			if configID != "thinking" || value == "on" {
				return nil
			}
			return &kimiRPCError{Code: -32602, Message: "Invalid params: Unknown thinking effort"}
		})
	if err != nil {
		t.Fatalf("configureSession = %v, want the rejected effort to be absorbed", err)
	}
	want := []kimiSetConfigCall{{"thinking", "max"}, {"thinking", "on"}, {"mode", "default"}}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("config calls = %v, want %v", calls, want)
	}
}

// Only the effort is negotiable. Any other rejection still fails the session
// rather than running it under a configuration Orbit did not ask for.
func TestKimiConfigureSessionStillFailsOnOtherRejections(t *testing.T) {
	calls, err := runKimiConfigureSession(t,
		AgentExecConfig{Effort: "max", PermissionMode: "default"},
		[]string{"off", "on"},
		func(configID, _ string) *kimiRPCError {
			if configID != "mode" {
				return nil
			}
			return &kimiRPCError{Code: -32602, Message: "Invalid params: unknown mode"}
		})
	if err == nil {
		t.Fatal("configureSession succeeded, want the rejected mode to fail the session")
	}
	want := []kimiSetConfigCall{{"thinking", "on"}, {"mode", "default"}}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("config calls = %v, want %v", calls, want)
	}
}

// A transport-level failure is not a "this model cannot do that level" answer,
// so it must not be retried into a silent downgrade.
func TestKimiThinkingRetryOnlyOnInvalidParams(t *testing.T) {
	calls, err := runKimiConfigureSession(t,
		AgentExecConfig{Effort: "max", PermissionMode: "default"},
		nil,
		func(configID, _ string) *kimiRPCError {
			if configID != "thinking" {
				return nil
			}
			return &kimiRPCError{Code: -32603, Message: "Internal error"}
		})
	if err == nil {
		t.Fatal("configureSession succeeded, want an internal error to fail the session")
	}
	want := []kimiSetConfigCall{{"thinking", "max"}}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("config calls = %v, want %v", calls, want)
	}
}

// The handshake shape Kimi actually sends, straight from a `session/new` result.
func TestKimiConfigOptionValuesReadsAdvertisedPicker(t *testing.T) {
	var result map[string]interface{}
	if err := json.Unmarshal([]byte(`{"sessionId":"session_1","configOptions":[
		{"type":"select","id":"model","currentValue":"__kimi_env_model__","options":[{"value":"__kimi_env_model__","name":"kimi-k3"}]},
		{"type":"select","id":"thinking","currentValue":"on","options":[{"value":"off","name":"Off"},{"value":"on","name":"On"}]}
	]}`), &result); err != nil {
		t.Fatal(err)
	}
	if got := kimiConfigOptionValues(result, "thinking"); !reflect.DeepEqual(got, []string{"off", "on"}) {
		t.Fatalf("thinking values = %v, want [off on]", got)
	}
	if got := kimiConfigOptionValues(result, "mode"); got != nil {
		t.Fatalf("absent option = %v, want nil so callers read it as unknown", got)
	}
}

func TestKimiUsesEnvModelRequiresCompleteOverride(t *testing.T) {
	t.Setenv("KIMI_MODEL_NAME", "")
	t.Setenv("KIMI_MODEL_API_KEY", "")
	if !kimiUsesEnvModel(map[string]string{
		"KIMI_MODEL_NAME": "kimi-for-coding", "KIMI_MODEL_API_KEY": "sk-test",
	}) {
		t.Fatal("complete environment model override was not recognized")
	}
	if kimiUsesEnvModel(map[string]string{"KIMI_MODEL_API_KEY": "sk-test"}) {
		t.Fatal("API key alone must not activate Kimi's environment model")
	}
}

func TestKimiUsesEnvModelLayersAgentEnvironmentOverProcess(t *testing.T) {
	t.Setenv("KIMI_MODEL_NAME", "process-model")
	t.Setenv("KIMI_MODEL_API_KEY", "process-key")
	if !kimiUsesEnvModel(nil) {
		t.Fatal("complete process environment override was not inherited")
	}
	if !kimiUsesEnvModel(map[string]string{"KIMI_MODEL_NAME": "agent-model"}) {
		t.Fatal("agent model should inherit the process API key")
	}
	if kimiUsesEnvModel(map[string]string{"KIMI_MODEL_API_KEY": ""}) {
		t.Fatal("an explicit empty Agent API key must shadow the process value")
	}
	if kimiUsesEnvModel(map[string]string{"KIMI_MODEL_NAME": ""}) {
		t.Fatal("an explicit empty Agent model must shadow the process value")
	}

	t.Setenv("KIMI_MODEL_NAME", "")
	t.Setenv("KIMI_MODEL_API_KEY", "")
	if !kimiUsesEnvModel(map[string]string{
		"KIMI_MODEL_NAME": "agent-model", "KIMI_MODEL_API_KEY": "agent-key",
	}) {
		t.Fatal("complete Agent environment override was not recognized")
	}
}

func kimiMixedMCPAgent() AgentExecConfig {
	return AgentExecConfig{McpConfig: map[string]interface{}{
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
}

func TestKimiMCPServersConvertsACPShapes(t *testing.T) {
	got := kimiMCPServers(kimiMixedMCPAgent())
	if len(got) != 1 {
		t.Fatalf("servers = %#v", got)
	}
	if got[0]["name"] != "remote" || got[0]["type"] != "sse" || got[0]["url"] != "https://example.test/sse" {
		t.Fatalf("remote server = %#v", got[0])
	}
	if !reflect.DeepEqual(got[0]["headers"], []map[string]string{{"name": "Authorization", "value": "Bearer x"}}) {
		t.Fatalf("remote headers = %#v", got[0]["headers"])
	}
	// Kimi 0.38 parses a stdio server out of the ACP array and then rejects it for
	// having no `type`, failing session/new outright. Nothing without one may travel
	// this way, whatever else changes.
	for _, server := range got {
		if server["type"] == nil {
			t.Fatalf("ACP server %#v declares no type; Kimi answers those with -32603", server)
		}
	}
}

func TestKimiMCPConfigRecordCarriesStdioServers(t *testing.T) {
	got := kimiMCPConfigRecord(kimiMixedMCPAgent(), "/opt/orbit")
	if len(got) != 2 {
		t.Fatalf("record = %#v", got)
	}
	if _, ok := got["remote"]; ok {
		t.Fatalf("sse server took the config file route as well: %#v", got)
	}
	stdio := mapValue(got["stdio"])
	if stdio["command"] != "node" {
		t.Fatalf("stdio server = %#v", stdio)
	}
	if !reflect.DeepEqual(stdio["args"], []string{"server.js", "--stdio"}) {
		t.Fatalf("stdio args = %#v", stdio["args"])
	}
	// The config file spells env as an object; the ACP array spelled it [{name,value}].
	if !reflect.DeepEqual(stdio["env"], map[string]string{"TOKEN": "x"}) {
		t.Fatalf("stdio env = %#v", stdio["env"])
	}
	if _, ok := stdio["name"]; ok {
		t.Fatalf("stdio server repeats its key as a field: %#v", stdio)
	}

	orbit := mapValue(got["orbit"])
	if orbit["command"] != "/opt/orbit" {
		t.Fatalf("orbit server = %#v", orbit)
	}
	if !reflect.DeepEqual(orbit["args"], []string{"mcp"}) {
		t.Fatalf("orbit args = %#v", orbit["args"])
	}
	// Empty on purpose: `orbit mcp` inherits ORBIT_SESSION_ID and friends from kimi's
	// environment, so this session's identity is never written into a file.
	if !reflect.DeepEqual(orbit["env"], map[string]string{}) {
		t.Fatalf("orbit env = %#v, want empty", orbit["env"])
	}

	// The expression the session start actually uses: the command has to be this
	// runner's own binary, since that is what serves `orbit mcp`.
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	live := mapValue(kimiMCPConfigRecord(AgentExecConfig{}, orbitCLIExecutable())["orbit"])
	if live["command"] != filepath.Clean(exe) {
		t.Fatalf("orbit command = %#v, want the runner executable %q", live["command"], exe)
	}
}

// An entry naming both a command and a url must be started once, not once per route.
func TestKimiMCPRoutesEachServerOnce(t *testing.T) {
	agent := AgentExecConfig{McpConfig: map[string]interface{}{
		"both": map[string]interface{}{
			"command": "node",
			"url":     "https://example.test/mcp",
		},
	}}
	if got := kimiMCPServers(agent); len(got) != 0 {
		t.Fatalf("ACP servers = %#v, want the command-bearing entry left to the config file", got)
	}
	record := kimiMCPConfigRecord(agent, "")
	if len(record) != 1 || mapValue(record["both"])["command"] != "node" {
		t.Fatalf("record = %#v", record)
	}
}

// Env and headers reach Orbit in three shapes; the config file needs every one of them
// as an object.
func TestKimiStringMapAcceptsEverySourceShape(t *testing.T) {
	want := map[string]string{"A": "1", "B": "2"}
	for name, value := range map[string]interface{}{
		"map[string]string":      map[string]string{"A": "1", "B": "2"},
		"map[string]interface{}": map[string]interface{}{"A": "1", "B": "2"},
		"name/value array": []interface{}{
			map[string]interface{}{"name": "A", "value": "1"},
			map[string]interface{}{"name": "B", "value": "2"},
		},
	} {
		if got := kimiStringMap(value); !reflect.DeepEqual(got, want) {
			t.Fatalf("kimiStringMap(%s) = %#v, want %#v", name, got, want)
		}
	}
	if got := kimiStringMap(nil); !reflect.DeepEqual(got, map[string]string{}) {
		t.Fatalf("kimiStringMap(nil) = %#v, want empty", got)
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

// ACP delivers Kimi's scratch checklist as a plan update, which Orbit dropped: work
// recorded there instead of in an Orbit task was invisible everywhere. Each update
// replaces the whole plan, so successive versions must be distinct tool calls.
func TestHandleKimiPlanUpdateRendersChecklist(t *testing.T) {
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
	plan := func(status string) map[string]interface{} {
		return map[string]interface{}{
			"sessionUpdate": "plan",
			"entries": []interface{}{
				map[string]interface{}{"content": "add the case", "status": status},
			},
		}
	}
	handleKimiNotification("session-1", kimiNotification(t, "session-1", plan("pending")), emit, &mu, &active)
	handleKimiNotification("session-1", kimiNotification(t, "session-1", plan("completed")), emit, &mu, &active)
	if len(events) != 4 {
		t.Fatalf("events = %#v, want a tool_use/tool_result pair per plan update", events)
	}
	if events[0].typ != evToolUse || events[0].payload["name"] != "plan" {
		t.Fatalf("first event = %#v, want a plan tool_use", events[0])
	}
	if events[1].payload["content"] != "- [ ] add the case" {
		t.Fatalf("first checklist = %q", events[1].payload["content"])
	}
	if events[3].payload["content"] != "- [x] add the case" {
		t.Fatalf("second checklist = %q", events[3].payload["content"])
	}
	if events[0].payload["id"] == events[2].payload["id"] {
		t.Fatalf("plan updates reused tool id %v", events[0].payload["id"])
	}
	// An empty plan carries nothing to show and must not open a card.
	handleKimiNotification("session-1", kimiNotification(t, "session-1",
		map[string]interface{}{"sessionUpdate": "plan"}), emit, &mu, &active)
	if len(events) != 4 {
		t.Fatalf("empty plan emitted %#v", events[4:])
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
	// ~/.kimi-code/bin is where the official installer puts the `kimi` binary; its
	// only way onto PATH is an export line in a shell rc, which a service never
	// sources. Without it the install succeeds and the binary stays unreachable.
	for _, want := range []string{"/home/alice/.local/bin", "/home/alice/.kimi-code/bin", "/usr/bin"} {
		if !pathContains(got, want) {
			t.Fatalf("runnerEnginePath = %q, missing %q", got, want)
		}
	}
	if twice := runnerEnginePath("/home/alice", got); twice != got {
		t.Fatalf("runnerEnginePath is not idempotent: %q -> %q", got, twice)
	}
}
