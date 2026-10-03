package main

// What a runner's codex sends to the shared Codex pools' gateway, read off the installed engine.
//
// The gateway (src/apiserver/src/providers/pool-gateway.service.ts) passes what codex sends on to
// OpenAI byte for byte, swapping only the credential, and admits only the paths on its list. Both
// halves are claims about codex, so they are measured here rather than assumed: production's own
// builders (codexAppServerCommandArgs, codexThreadParams, codexTurnParams) drive a real
// `codex app-server` whose environment is what a shared-pool claim hands a job —
// OPENAI_BASE_URL = <origin>/api/gw/codex and OPENAI_API_KEY = a session token — against a recorder
// standing where the gateway stands. It checks that
//
//   - every request codex makes is POST <gateway>/responses, the gateway's whole path list;
//   - each carries the session token as its bearer credential;
//   - codex completes a turn on the recorded Responses stream, so the stream the gateway's replay spec
//     forwards (src/apiserver/src/providers/pool-gateway.pg.spec.ts) is one codex accepts.
//
// With ORBIT_RECORD_CODEX_GATEWAY_FIXTURE=<file> it also writes the exchange — codex's request as sent
// and the stream it was answered with — to that file, which is the fixture that spec replays through
// the real gateway. Re-record it when codex is upgraded:
//
//   env -u ORBIT_SESSION_ID -u ORBIT_TASK_ID -u ORBIT_AGENT_ID \
//     ORBIT_RECORD_CODEX_GATEWAY_FIXTURE=$PWD/../apiserver/src/providers/fixtures/codex-gateway-recording.json \
//     go test -run TestRealCodexThroughThePoolGateway -count=1 .
//
// Nothing reaches the network and nothing needs a login; it skips without a `codex` on PATH.

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"
)

// The token a pool claim would mint (shared-pool.ts mintPoolGatewayToken): `orbit-gw-` and 43 base64url
// characters. Fixed, so the fixture names it and the replay can swap in one it minted itself.
const recordedGatewayToken = "orbit-gw-RECORDEDxRECORDEDxRECORDEDxRECORDEDxRECORDE"

// Where a pool claim points codex, under whatever origin the deployment has (shared-pool.ts poolGatewayUrl).
const recordedGatewayPath = "/api/gw/codex"

type recordedExchange struct {
	Method     string      `json:"method"`
	Path       string      `json:"path"`
	Headers    [][2]string `json:"headers"`
	BodyBase64 string      `json:"bodyBase64"`
}

type recordedAnswer struct {
	Status     int         `json:"status"`
	Headers    [][2]string `json:"headers"`
	BodyBase64 string      `json:"bodyBase64"`
}

type gatewayRecording struct {
	Note     string           `json:"note"`
	Codex    string           `json:"codex"`
	Request  recordedExchange `json:"request"`
	Response recordedAnswer   `json:"response"`
}

// gatewayRecorder stands where the gateway does: it keeps every request codex sends and answers each
// /responses with a Responses API stream that completes the turn.
type gatewayRecorder struct {
	mu       sync.Mutex
	requests []recordedExchange
	answer   []byte
}

func (rec *gatewayRecorder) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	headers := make([][2]string, 0, len(r.Header)+1)
	for name, values := range r.Header {
		for _, value := range values {
			headers = append(headers, [2]string{strings.ToLower(name), value})
		}
	}
	headers = append(headers, [2]string{"host", r.Host})
	sort.Slice(headers, func(i, j int) bool { return headers[i][0] < headers[j][0] })
	rec.mu.Lock()
	rec.requests = append(rec.requests, recordedExchange{
		Method: r.Method, Path: r.URL.RequestURI(), Headers: headers, BodyBase64: base64.StdEncoding.EncodeToString(body),
	})
	rec.mu.Unlock()
	if r.Method != http.MethodPost || r.URL.Path != recordedGatewayPath+"/responses" {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	var req struct {
		Model string `json:"model"`
	}
	_ = json.Unmarshal(body, &req)
	rec.mu.Lock()
	rec.answer = recordedResponsesStream(req.Model)
	answer := rec.answer
	rec.mu.Unlock()
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("X-Request-Id", "req_recorded")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(answer)
}

// recordedResponsesStream is a Responses API stream as OpenAI sends one: the response created, one
// assistant message streamed as text deltas, and `response.completed` carrying the whole response and its
// usage — which is what the gateway reads its ledger entry off.
func recordedResponsesStream(model string) []byte {
	if model == "" {
		model = "gpt-5.1-codex"
	}
	created := map[string]interface{}{
		"id": "resp_recorded", "object": "response", "created_at": 1790582908, "status": "in_progress",
		"model": model, "output": []interface{}{}, "service_tier": "default",
	}
	message := map[string]interface{}{
		"id": "msg_recorded", "type": "message", "status": "completed", "role": "assistant",
		"content": []interface{}{map[string]interface{}{"type": "output_text", "text": "DONE", "annotations": []interface{}{}}},
	}
	completed := map[string]interface{}{}
	for k, v := range created {
		completed[k] = v
	}
	completed["status"] = "completed"
	completed["output"] = []interface{}{message}
	completed["usage"] = map[string]interface{}{
		"input_tokens": 11290, "input_tokens_details": map[string]interface{}{"cached_tokens": 9984},
		"output_tokens": 57, "output_tokens_details": map[string]interface{}{"reasoning_tokens": 48}, "total_tokens": 11347,
	}
	events := []map[string]interface{}{
		{"type": "response.created", "sequence_number": 0, "response": created},
		{"type": "response.in_progress", "sequence_number": 1, "response": created},
		{"type": "response.output_item.added", "sequence_number": 2, "output_index": 0, "item": map[string]interface{}{
			"id": "msg_recorded", "type": "message", "status": "in_progress", "role": "assistant", "content": []interface{}{}}},
		{"type": "response.content_part.added", "sequence_number": 3, "item_id": "msg_recorded", "output_index": 0, "content_index": 0,
			"part": map[string]interface{}{"type": "output_text", "text": "", "annotations": []interface{}{}}},
		{"type": "response.output_text.delta", "sequence_number": 4, "item_id": "msg_recorded", "output_index": 0, "content_index": 0, "delta": "DO"},
		{"type": "response.output_text.delta", "sequence_number": 5, "item_id": "msg_recorded", "output_index": 0, "content_index": 0, "delta": "NE"},
		{"type": "response.output_text.done", "sequence_number": 6, "item_id": "msg_recorded", "output_index": 0, "content_index": 0, "text": "DONE"},
		{"type": "response.content_part.done", "sequence_number": 7, "item_id": "msg_recorded", "output_index": 0, "content_index": 0,
			"part": map[string]interface{}{"type": "output_text", "text": "DONE", "annotations": []interface{}{}}},
		{"type": "response.output_item.done", "sequence_number": 8, "output_index": 0, "item": message},
		{"type": "response.completed", "sequence_number": 9, "response": completed},
	}
	var out strings.Builder
	for _, event := range events {
		data, _ := json.Marshal(event)
		fmt.Fprintf(&out, "event: %s\ndata: %s\n\n", event["type"], data)
	}
	return []byte(out.String())
}

func TestRealCodexThroughThePoolGateway(t *testing.T) {
	t.Parallel()
	exe, err := exec.LookPath("codex")
	if err != nil {
		t.Skip("no codex on PATH; this recording needs a real app-server")
	}
	rec := &gatewayRecorder{}
	gateway := httptest.NewServer(rec)
	t.Cleanup(gateway.Close)

	job := &ClaimedSession{Agent: AgentExecConfig{
		Model: "gpt-5.1-codex",
		// What a shared-pool claim hands the job (queue.service.ts resolveSharedPool).
		Env: map[string]string{
			"OPENAI_BASE_URL": gateway.URL + recordedGatewayPath,
			"OPENAI_API_KEY":  recordedGatewayToken,
		},
	}}
	env, home := isolatedCodexProbeEnv(t)
	dir := t.TempDir()
	for key, value := range job.Agent.Env {
		env = envWithValue(env, key, value)
	}
	// No Orbit executable: no MCP server is launched beside it.
	cmd := exec.Command(exe, codexAppServerCommandArgs(job, home+"/state", "")...)
	cmd.Env = env
	configureCodexProbeProcess(cmd)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Skipf("cannot run %s app-server: %v", exe, err)
	}
	t.Cleanup(func() {
		if err := stopCodexProbeProcess(cmd, stdin); err != nil {
			t.Errorf("app-server cleanup: %v", err)
		}
	})
	out := bufio.NewReaderSize(stdout, 1<<20)
	next := 0
	send := func(msg map[string]interface{}) {
		b, _ := json.Marshal(msg)
		if _, err := stdin.Write(append(b, '\n')); err != nil {
			t.Fatalf("write %v: %v", msg["method"], err)
		}
	}
	read := func() codexRPCMessage {
		line, err := out.ReadBytes('\n')
		if err != nil {
			t.Fatalf("reading the app-server: %v", err)
		}
		var msg codexRPCMessage
		if json.Unmarshal(line, &msg) != nil {
			return codexRPCMessage{}
		}
		return msg
	}
	request := func(method string, params map[string]interface{}) codexRPCMessage {
		next++
		id := next
		send(map[string]interface{}{"id": id, "method": method, "params": params})
		for {
			msg := read()
			if msg.Method == "" && fmt.Sprint(msg.ID) == fmt.Sprint(id) {
				return msg
			}
		}
	}
	request("initialize", map[string]interface{}{
		"clientInfo":   map[string]interface{}{"name": "orbit", "title": "Orbit", "version": "0.1.0"},
		"capabilities": map[string]interface{}{"experimentalApi": true},
	})
	send(map[string]interface{}{"method": "initialized", "params": map[string]interface{}{}})

	started := request("thread/start", codexThreadParams(job, dir, dir))
	if started.Error != nil {
		t.Fatalf("thread/start: %v", started.Error.Message)
	}
	threadID := threadIDFromResult(rawObject(started.Result))
	turn := codexTurnParams(threadID, job, dir, dir, "orbit-gateway-recording-turn", "Say DONE.", nil, codexTurnContextOptions{})
	if resp := request("turn/start", turn); resp.Error != nil {
		t.Fatalf("turn/start: %v", resp.Error.Message)
	}
	status := ""
	deadline := time.Now().Add(90 * time.Second)
	for status == "" && time.Now().Before(deadline) {
		msg := read()
		if msg.Method == "turn/completed" {
			status = strings.ToLower(nestedString(rawObject(msg.Params), "turn", "status"))
		}
	}
	if status != "completed" {
		t.Fatalf("codex did not complete its turn on the recorded stream (status %q)", status)
	}

	rec.mu.Lock()
	requests := append([]recordedExchange(nil), rec.requests...)
	answer := rec.answer
	rec.mu.Unlock()
	if len(requests) == 0 {
		t.Fatal("codex sent the gateway nothing")
	}
	for _, r := range requests {
		// The gateway's whole path list (pool-gateway.service.ts ALLOWED): anything else it refuses.
		if r.Method != http.MethodPost || r.Path != recordedGatewayPath+"/responses" {
			t.Fatalf("codex asked the gateway for %s %s, which it does not forward", r.Method, r.Path)
		}
		bearer := ""
		for _, h := range r.Headers {
			if h[0] == "authorization" {
				bearer = h[1]
			}
		}
		if bearer != "Bearer "+recordedGatewayToken {
			t.Fatalf("codex authenticated with %q, not the session token", bearer)
		}
	}

	target := os.Getenv("ORBIT_RECORD_CODEX_GATEWAY_FIXTURE")
	if target == "" {
		return
	}
	version, _ := exec.Command(exe, "--version").Output()
	fixture := gatewayRecording{
		Note: "Written by src/runner-go/codex_gateway_recording_test.go from a real codex app-server driven by " +
			"production's builders; replayed through the real gateway by pool-gateway.pg.spec.ts. Re-record on a codex upgrade.",
		Codex:   strings.TrimSpace(string(version)),
		Request: requests[0],
		Response: recordedAnswer{
			Status:     http.StatusOK,
			Headers:    [][2]string{{"content-type", "text/event-stream; charset=utf-8"}, {"x-request-id", "req_recorded"}},
			BodyBase64: base64.StdEncoding.EncodeToString(answer),
		},
	}
	data, err := json.MarshalIndent(fixture, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target, append(data, '\n'), 0o644); err != nil {
		t.Fatalf("writing the fixture: %v", err)
	}
	t.Logf("recorded %s's request (%d bytes) to %s", fixture.Codex, len(requests[0].BodyBase64)*3/4, target)
}
