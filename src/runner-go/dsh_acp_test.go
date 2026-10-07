package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

const dshMockSessionID = "dsh-process-session"
const dshMockModel = `["synthetic-provider","model/with opaque value"]`

type dshProcessEvent struct {
	turn    string
	typ     string
	payload map[string]interface{}
}

type dshProcessEvents struct {
	mu     sync.Mutex
	events []dshProcessEvent
}

func (e *dshProcessEvents) emit(turn, typ string, payload map[string]interface{}) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.events = append(e.events, dshProcessEvent{turn, typ, payload})
}

func (e *dshProcessEvents) snapshot() []dshProcessEvent {
	e.mu.Lock()
	defer e.mu.Unlock()
	return append([]dshProcessEvent(nil), e.events...)
}

// The subprocess receives only synthetic configuration and runs this test binary,
// so no installed engine or account participates in the process tests.
func dshMockLaunchSpec(t *testing.T, mode string) (DshLaunchSpec, string) {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cwd, home := t.TempDir(), t.TempDir()
	record := filepath.Join(t.TempDir(), "requests.ndjson")
	return DshLaunchSpec{
		Executable: exe,
		Args:       []string{"-test.run=^TestDshACPHelperProcess$"},
		Env: []string{
			"PATH=" + os.Getenv("PATH"), "HOME=" + t.TempDir(), "DSH_HOME=" + home,
			"DSH_TEST_MODE=" + mode, "DSH_TEST_RECORD=" + record,
		},
		Cwd: cwd, DshHome: home, Version: "0.2.0-rc.2", ConfigHash: "synthetic-config-hash",
	}, record
}

func dshProcessClient(t *testing.T, mode string, emit emitTurnFn) (*dshACPClient, *dshEventMapper, context.Context, string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	t.Cleanup(cancel)
	spec, record := dshMockLaunchSpec(t, mode)
	mapper := newDshEventMapper(dshMockSessionID, emit)
	client, err := startDshACP(ctx, spec, mapper, nil, func(string, map[string]interface{}) {})
	if err != nil {
		t.Fatalf("start mock dsh: %v", err)
	}
	t.Cleanup(client.dispose)
	if err := client.initialize(ctx); err != nil {
		t.Fatalf("initialize: %v", err)
	}
	id, err := client.open(ctx, spec.Cwd, nil)
	if err != nil || id != dshMockSessionID {
		t.Fatalf("session/new = %q, %v", id, err)
	}
	return client, mapper, ctx, record
}

func dshProcessRequests(t *testing.T, record string) []map[string]interface{} {
	t.Helper()
	data, err := os.ReadFile(record)
	if err != nil {
		t.Fatal(err)
	}
	var requests []map[string]interface{}
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		var request map[string]interface{}
		if err := json.Unmarshal([]byte(line), &request); err != nil {
			t.Fatalf("mock request record: %v", err)
		}
		requests = append(requests, request)
	}
	return requests
}

func TestDshACPProcessMultiTurn(t *testing.T) {
	var events dshProcessEvents
	client, mapper, ctx, record := dshProcessClient(t, "multiturn", events.emit)
	if err := client.configure(ctx, dshMockSessionID, AgentExecConfig{Model: "model/with opaque value", Effort: "low"}); err != nil {
		t.Fatalf("configure from live model options: %v", err)
	}
	for i, text := range []string{"first prompt", "second prompt"} {
		turn := fmt.Sprintf("local-turn-%d", i+1)
		if err := mapper.begin(turn); err != nil {
			t.Fatal(err)
		}
		result, err := client.prompt(ctx, dshMockSessionID, turn, text)
		if err != nil {
			t.Fatalf("prompt %d: %v", i+1, err)
		}
		complete, accepted := mapper.settle(turn, result, nil)
		if !accepted || complete.Status != stSucceeded || complete.RuntimeSessionID != dshMockSessionID || complete.Result != fmt.Sprintf("reply-%d", i+1) {
			t.Fatalf("turn %d settlement: %+v, accepted=%v", i+1, complete, accepted)
		}
		if _, accepted := mapper.settle(turn, result, nil); accepted {
			t.Fatalf("turn %d settled twice", i+1)
		}
	}
	if err := client.closeSession(ctx, dshMockSessionID); err != nil {
		t.Fatalf("session/close: %v", err)
	}
	all := events.snapshot()
	for _, turn := range []string{"local-turn-1", "local-turn-2"} {
		counts := map[string]int{}
		for _, event := range all {
			if event.turn != turn {
				continue
			}
			counts[event.typ]++
			if event.payload["runtimeSessionId"] != dshMockSessionID || event.payload["localTurnId"] != turn {
				t.Fatalf("event attribution: %+v", event)
			}
		}
		for _, typ := range []string{evAssistant, evThinking, evToolUse, evToolResult, evTurnEnd} {
			if counts[typ] != 1 {
				t.Fatalf("%s %s count = %d; events=%+v", turn, typ, counts[typ], all)
			}
		}
		if counts[evTextDelta] != 0 || counts[evThinkingDelta] != 0 {
			t.Fatalf("committed blocks were presented as token deltas: %v", counts)
		}
	}
	var methods []string
	for _, request := range dshProcessRequests(t, record) {
		method := firstString(request, "method")
		methods = append(methods, method)
		params := mapValue(request["params"])
		if method == "session/set_config_option" && params["configId"] == "model" && params["value"] != dshMockModel {
			t.Fatalf("model selection must relay opaque live option: %+v", params)
		}
		if method == "session/set_config_option" && params["configId"] == "reasoning_effort" && params["value"] != "low" {
			t.Fatalf("reasoning selection did not reach dsh: %+v", params)
		}
		if strings.HasPrefix(method, "session/") && method != "session/new" && params["sessionId"] != dshMockSessionID {
			t.Fatalf("request lost ACP session id: %+v", request)
		}
	}
	want := []string{"initialize", "session/new", "session/set_config_option", "session/set_config_option", "session/prompt", "session/prompt", "session/close"}
	if !reflect.DeepEqual(methods, want) {
		t.Fatalf("resident process request sequence = %v, want %v", methods, want)
	}
}

func TestDshACPResponseBarrier(t *testing.T) {
	var events dshProcessEvents
	tailSeen, release := make(chan struct{}), make(chan struct{})
	var releaseOnce sync.Once
	releaseTail := func() { releaseOnce.Do(func() { close(release) }) }
	emit := func(turn, typ string, payload map[string]interface{}) {
		events.emit(turn, typ, payload)
		if typ == evAssistant && payload["text"] == "tail" {
			close(tailSeen)
			<-release
		}
	}
	client, mapper, ctx, _ := dshProcessClient(t, "barrier", emit)
	t.Cleanup(releaseTail)
	if err := mapper.begin("barrier-turn"); err != nil {
		t.Fatal(err)
	}
	type reply struct {
		result map[string]interface{}
		err    error
	}
	finished := make(chan reply, 1)
	go func() {
		result, err := client.prompt(ctx, dshMockSessionID, "barrier-turn", "burst")
		finished <- reply{result, err}
	}()
	select {
	case <-tailSeen:
	case <-ctx.Done():
		t.Fatal("final update did not reach the event consumer")
	}
	select {
	case result := <-finished:
		t.Fatalf("prompt returned before the final update consumer finished: %+v", result)
	default:
	}
	releaseTail()
	var response reply
	select {
	case response = <-finished:
	case <-ctx.Done():
		t.Fatal("prompt response stayed blocked after the final update")
	}
	if response.err != nil {
		t.Fatal(response.err)
	}
	complete, accepted := mapper.settle("barrier-turn", response.result, nil)
	if !accepted || complete.Status != stSucceeded {
		t.Fatalf("settle after barrier: %+v, accepted=%v", complete, accepted)
	}
	all := events.snapshot()
	if len(all) != 602 || all[600].typ != evAssistant || all[600].payload["text"] != "tail" || all[601].typ != evTurnEnd {
		t.Fatalf("600 committed updates plus tail must precede one turn_end; got %d events", len(all))
	}
}

func TestDshACPStartupAndProtocolFailures(t *testing.T) {
	for _, name := range []string{"missing-executable", "unsupported-version"} {
		t.Run(name, func(t *testing.T) {
			spec, _ := dshMockLaunchSpec(t, "multiturn")
			if name == "missing-executable" {
				spec.Executable = filepath.Join(t.TempDir(), "missing-dsh")
			} else {
				spec.Version = "0.0.1"
			}
			client, err := startDshACP(context.Background(), spec, nil, nil, func(string, map[string]interface{}) {})
			if client != nil {
				client.dispose()
			}
			if err == nil {
				t.Fatalf("%s was accepted", name)
			}
		})
	}
	for _, mode := range []string{"malformed-stdout", "wrong-protocol-version"} {
		t.Run(mode, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			spec, _ := dshMockLaunchSpec(t, mode)
			client, err := startDshACP(ctx, spec, nil, nil, func(string, map[string]interface{}) {})
			if err != nil {
				t.Fatal(err)
			}
			defer client.dispose()
			err = client.initialize(ctx)
			if err == nil || errors.Is(err, context.DeadlineExceeded) {
				t.Fatalf("initialize must reject %s promptly: %v", mode, err)
			}
		})
	}
	for _, mode := range []string{"eof-zero", "unclosed-tool"} {
		t.Run(mode, func(t *testing.T) {
			var events dshProcessEvents
			client, mapper, ctx, _ := dshProcessClient(t, mode, events.emit)
			if err := mapper.begin("failed-turn"); err != nil {
				t.Fatal(err)
			}
			result, err := client.prompt(ctx, dshMockSessionID, "failed-turn", "unfinished")
			if mode == "eof-zero" && (err == nil || errors.Is(err, context.DeadlineExceeded)) {
				t.Fatalf("exit 0 without prompt response must fail promptly: %v", err)
			}
			complete, accepted := mapper.settle("failed-turn", result, err)
			if !accepted || complete.Status != stFailed || complete.Error == "" {
				t.Fatalf("unfinished turn must fail: %+v, accepted=%v", complete, accepted)
			}
			all := events.snapshot()
			terminalTools := 0
			for _, event := range all {
				if event.typ == evToolResult && event.payload["toolCallId"] == "same-tool-id" && event.payload["isError"] == true {
					terminalTools++
				}
			}
			if terminalTools != 1 || all[len(all)-1].typ != evTurnEnd {
				t.Fatalf("unfinished tool must get a terminal result before settlement: %+v", all)
			}
			if _, accepted := mapper.settle("failed-turn", result, err); accepted {
				t.Fatal("failed turn settled twice")
			}
		})
	}
	t.Run("rpc-error-does-not-poison-next-turn", func(t *testing.T) {
		var events dshProcessEvents
		client, mapper, ctx, _ := dshProcessClient(t, "recover-error", events.emit)
		for i := 1; i <= 2; i++ {
			turn := fmt.Sprintf("recovery-%d", i)
			if err := mapper.begin(turn); err != nil {
				t.Fatal(err)
			}
			result, err := client.prompt(ctx, dshMockSessionID, turn, "recover")
			complete, accepted := mapper.settle(turn, result, err)
			if !accepted {
				t.Fatalf("turn %d was not settled", i)
			}
			if i == 1 && (err == nil || complete.Status != stFailed || !strings.Contains(complete.Error, "synthetic 401 failure")) {
				t.Fatalf("RPC error was lost: err=%v complete=%+v", err, complete)
			}
			if i == 2 && (err != nil || complete.Status != stSucceeded || complete.Error != "" || complete.Result != "reply-2") {
				t.Fatalf("second prompt retained prior error: err=%v complete=%+v", err, complete)
			}
		}
	})
	t.Run("unknown-live-model-rejected", func(t *testing.T) {
		client, _, ctx, _ := dshProcessClient(t, "multiturn", func(string, string, map[string]interface{}) {})
		if err := client.configure(ctx, dshMockSessionID, AgentExecConfig{Model: "missing-model"}); err == nil {
			t.Fatal("unknown model must not be reconstructed or silently replaced")
		}
	})
	t.Run("non-object-result", func(t *testing.T) {
		client, _, ctx, _ := dshProcessClient(t, "non-object-result", func(string, string, map[string]interface{}) {})
		if err := client.closeSession(ctx, dshMockSessionID); err == nil || errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("non-object session/close result must be rejected promptly: %v", err)
		}
	})
}

func TestDshACPHelperProcess(t *testing.T) {
	mode := os.Getenv("DSH_TEST_MODE")
	if mode == "" {
		return
	}
	record, err := os.OpenFile(os.Getenv("DSH_TEST_RECORD"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	encoder, recorder := json.NewEncoder(os.Stdout), json.NewEncoder(record)
	write := func(value map[string]interface{}) { _ = encoder.Encode(value) }
	respond := func(id interface{}, result map[string]interface{}) {
		write(map[string]interface{}{"jsonrpc": "2.0", "id": id, "result": result})
	}
	update := func(body map[string]interface{}) {
		write(map[string]interface{}{"jsonrpc": "2.0", "method": "session/update", "params": map[string]interface{}{"sessionId": dshMockSessionID, "update": body}})
	}
	model, effort, prompts := `["synthetic-provider","initial-model"]`, "high", 0
	var heldPrompt interface{} // permission mode: the prompt waiting on the approval reply
	options := func() []interface{} {
		return []interface{}{
			map[string]interface{}{"id": "model", "category": "model", "type": "select", "currentValue": model, "options": []interface{}{
				map[string]interface{}{"group": "synthetic-provider", "name": "Synthetic", "options": []interface{}{
					map[string]interface{}{"value": dshMockModel, "name": "Opaque display label"},
				}},
			}},
			map[string]interface{}{"id": "reasoning_effort", "category": "thought_level", "type": "select", "currentValue": effort, "options": []interface{}{
				map[string]interface{}{"value": "low", "name": "Low"}, map[string]interface{}{"value": "high", "name": "High"},
			}},
		}
	}
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		var request map[string]interface{}
		if json.Unmarshal(scanner.Bytes(), &request) != nil {
			os.Exit(2)
		}
		_ = recorder.Encode(request)
		id, params := request["id"], mapValue(request["params"])
		if request["method"] == nil && id == "perm-1" && heldPrompt != nil {
			// The approval reply: settle the tool the way the real CLI does, then the prompt.
			status := "failed"
			if firstString(mapValue(mapValue(request["result"])["outcome"]), "optionId") == "allow-once" {
				status = "completed"
			}
			update(map[string]interface{}{"sessionUpdate": "tool_call_update", "toolCallId": "perm-tool", "status": status, "content": []interface{}{}})
			update(map[string]interface{}{"sessionUpdate": "agent_message_chunk", "messageId": "after-card", "content": map[string]interface{}{"type": "text", "text": "after-" + status}})
			respond(heldPrompt, map[string]interface{}{"stopReason": "end_turn"})
			heldPrompt = nil
			continue
		}
		switch request["method"] {
		case "initialize":
			if mode == "malformed-stdout" {
				fmt.Fprintln(os.Stdout, "non-protocol startup output")
				continue
			}
			version := 1
			if mode == "wrong-protocol-version" {
				version = 99
			}
			respond(id, map[string]interface{}{"protocolVersion": version, "agentInfo": map[string]interface{}{"name": "deepseek-harness-acp", "version": "0.0.1"}, "agentCapabilities": map[string]interface{}{"sessionCapabilities": map[string]interface{}{"close": map[string]interface{}{}}}})
		case "session/new":
			cwd, _ := os.Getwd()
			if params["cwd"] != cwd || params["mcpServers"] == nil {
				fmt.Fprintln(os.Stderr, "session/new missing canonical cwd or mcpServers")
				os.Exit(2)
			}
			respond(id, map[string]interface{}{"sessionId": dshMockSessionID, "configOptions": options()})
		case "session/set_config_option":
			if params["configId"] == "model" {
				model = firstString(params, "value")
			} else {
				effort = firstString(params, "value")
			}
			update(map[string]interface{}{"sessionUpdate": "config_option_update", "configOptions": options()})
			respond(id, map[string]interface{}{"configOptions": options()})
		case "session/prompt":
			prompts++
			if mode == "recover-error" && prompts == 1 {
				write(map[string]interface{}{"jsonrpc": "2.0", "id": id, "error": map[string]interface{}{"code": -32603, "message": "synthetic 401 failure"}})
				continue
			}
			if failure, ok := dshMockPromptFailures[mode]; ok && prompts == 1 {
				write(map[string]interface{}{"jsonrpc": "2.0", "id": id, "error": failure})
				continue
			}
			if mode == "permission" {
				update(map[string]interface{}{"sessionUpdate": "tool_call", "toolCallId": "perm-tool", "title": "write", "kind": "other", "status": "in_progress",
					"rawInput": map[string]interface{}{"file_path": "approved.txt", "sandbox_permissions": "workspace-write"}})
				write(map[string]interface{}{"jsonrpc": "2.0", "id": "perm-1", "method": "session/request_permission", "params": map[string]interface{}{
					"sessionId": dshMockSessionID, "toolCall": map[string]interface{}{"toolCallId": "perm-tool"},
					"options": []interface{}{map[string]interface{}{"optionId": "allow-once", "kind": "allow_once"}, map[string]interface{}{"optionId": "reject-once", "kind": "reject_once"}}}})
				// Sent while the card is open: it must reach Orbit before any decision.
				update(map[string]interface{}{"sessionUpdate": "agent_thought_chunk", "messageId": "while-card", "content": map[string]interface{}{"type": "text", "text": "while-card-open"}})
				heldPrompt = id
				continue
			}
			if mode == "barrier" {
				for i := 0; i < 601; i++ {
					text := fmt.Sprintf("block-%d", i)
					if i == 600 {
						text = "tail"
					}
					update(map[string]interface{}{"sessionUpdate": "agent_message_chunk", "messageId": fmt.Sprintf("burst-%d", i), "content": map[string]interface{}{"type": "text", "text": text}})
				}
			} else {
				update(map[string]interface{}{"sessionUpdate": "tool_call", "toolCallId": "same-tool-id", "title": "read", "kind": "other", "status": "in_progress", "rawInput": map[string]interface{}{"file_path": "synthetic.txt"}})
				if mode == "eof-zero" {
					os.Exit(0)
				}
				if mode != "unclosed-tool" {
					update(map[string]interface{}{"sessionUpdate": "tool_call_update", "toolCallId": "same-tool-id", "status": "completed", "content": []interface{}{map[string]interface{}{"type": "content", "content": map[string]interface{}{"type": "text", "text": "synthetic result"}}}})
				}
				update(map[string]interface{}{"sessionUpdate": "agent_thought_chunk", "messageId": fmt.Sprintf("message-%d", prompts), "content": map[string]interface{}{"type": "text", "text": "synthetic thought"}})
				update(map[string]interface{}{"sessionUpdate": "agent_message_chunk", "messageId": fmt.Sprintf("message-%d", prompts), "content": map[string]interface{}{"type": "text", "text": fmt.Sprintf("reply-%d", prompts)}})
				update(map[string]interface{}{"sessionUpdate": "usage_update", "used": 5557 + prompts, "size": 1000000})
			}
			respond(id, map[string]interface{}{"stopReason": "end_turn"})
		case "session/close":
			if mode == "non-object-result" {
				write(map[string]interface{}{"jsonrpc": "2.0", "id": id, "result": []interface{}{}})
			} else {
				respond(id, map[string]interface{}{})
			}
		default:
			write(map[string]interface{}{"jsonrpc": "2.0", "id": id, "error": map[string]interface{}{"code": -32601, "message": "unsupported mock method"}})
		}
	}
	_ = record.Close()
	os.Exit(0)
}

// TestDshACPPermissionRoundTrip: an approval request reaches the bridge with the call it names, the
// reader keeps applying updates while the card is open, and the decision goes back on the wire.
func TestDshACPPermissionRoundTrip(t *testing.T) {
	for _, tc := range []struct{ decision, status, text string }{{dshAllowOnce, "completed", "after-completed"}, {dshRejectOnce, "failed", "after-failed"}} {
		t.Run(tc.decision, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			spec, record := dshMockLaunchSpec(t, "permission")
			var events dshProcessEvents
			mapper := newDshEventMapper(dshMockSessionID, events.emit)
			policy, _ := dshPermissionPolicyFor("default")
			sawThought := make(chan struct{})
			bridge := newDshPermissionBridge(func() dshPermissionPolicy { return policy }, mapper.toolCall,
				func(ctx context.Context, ask dshPermissionAsk) string {
					if ask.Name != "write" || mapValue(ask.Input)["file_path"] != "approved.txt" {
						t.Errorf("card = %+v", ask)
					}
					select {
					case <-sawThought:
					case <-ctx.Done():
						return ""
					}
					return tc.decision
				}, events.emit)
			client, err := startDshACP(ctx, spec, mapper, bridge, func(string, map[string]interface{}) {})
			if err != nil {
				t.Fatal(err)
			}
			defer client.dispose()
			if err := client.initialize(ctx); err != nil {
				t.Fatal(err)
			}
			if _, err := client.open(ctx, spec.Cwd, nil); err != nil {
				t.Fatal(err)
			}
			if err := mapper.begin("turn-1"); err != nil {
				t.Fatal(err)
			}
			bridge.begin()
			go func() {
				for ctx.Err() == nil {
					for _, event := range events.snapshot() {
						if event.typ == evThinking && event.payload["text"] == "while-card-open" {
							close(sawThought)
							return
						}
					}
					time.Sleep(5 * time.Millisecond)
				}
			}()
			result, err := client.prompt(ctx, dshMockSessionID, "turn-1", "write")
			if err != nil || result["stopReason"] != "end_turn" {
				t.Fatalf("prompt = %+v, %v", result, err)
			}
			req, _ := mapper.settle("turn-1", result, nil)
			var results map[string]interface{}
			for _, event := range events.snapshot() {
				if event.typ == evToolResult {
					results = event.payload
				}
			}
			if results["status"] != tc.status || req.Result != tc.text {
				t.Fatalf("tool result %+v, turn %+v", results, req)
			}
			var reply map[string]interface{}
			for _, request := range dshProcessRequests(t, record) {
				if request["id"] == "perm-1" {
					reply = request
				}
			}
			if outcome := mapValue(mapValue(reply["result"])["outcome"]); outcome["outcome"] != "selected" || outcome["optionId"] != tc.decision {
				t.Fatalf("wire reply = %+v", reply)
			}
		})
	}
}
