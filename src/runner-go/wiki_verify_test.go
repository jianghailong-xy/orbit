package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// `orbit wiki verify` against a fake vLLM endpoint (contract `agentSurface.verify`).
//
// Three stand-ins, each recording what reached it: a fake model endpoint that speaks the Anthropic
// Messages API and answers what a test scripted per op; a fake Orbit runner door that lists the ops
// and records every verdict reported; and, between them, a fake Claude Code — this test binary behind
// a shim — that does what the clean launch makes the real one do: read the prompt on stdin, run the
// apiKeyHelper its --settings name, call the endpoint with the Bearer token that prints, and answer in
// --output-format json. Where this machine has a real Claude Code, one test drives that instead.

// fakeVerifyClaudeDirEnv names the directory the fake Claude Code records into. The shim sets it,
// so TestMain (fake_claude_test.go) turns the re-executed test binary into the fake.
const fakeVerifyClaudeDirEnv = "ORBIT_FAKE_VERIFY_CLAUDE_DIR"

// fakeVerifySpawn is one run of the fake Claude Code: its argv, its whole environment, where it ran,
// and the prompt it was handed.
type fakeVerifySpawn struct {
	Args   []string `json:"args"`
	Env    []string `json:"env"`
	Cwd    string   `json:"cwd"`
	Prompt string   `json:"prompt"`
}

// runFakeVerifyClaude is the fake: one request to the endpoint, one JSON result on stdout.
func runFakeVerifyClaude(dir string) int {
	prompt, _ := io.ReadAll(os.Stdin)
	cwd, _ := os.Getwd()
	record, _ := json.Marshal(fakeVerifySpawn{Args: os.Args[1:], Env: os.Environ(), Cwd: cwd, Prompt: string(prompt)})
	if f, err := os.OpenFile(filepath.Join(dir, "spawns.jsonl"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644); err == nil {
		_, _ = f.Write(append(record, '\n'))
		_ = f.Close()
	}
	flag := func(name string) string {
		for i, arg := range os.Args[1:] {
			if arg == name && i+2 < len(os.Args) {
				return os.Args[i+2]
			}
		}
		return ""
	}
	result := func(isError bool, status interface{}, text string) int {
		out, _ := json.Marshal(map[string]interface{}{
			"type": "result", "subtype": "success", "is_error": isError, "api_error_status": status, "result": text,
		})
		fmt.Println(string(out))
		if isError {
			return 1
		}
		return 0
	}
	var settings struct {
		APIKeyHelper string `json:"apiKeyHelper"`
	}
	raw, err := os.ReadFile(flag("--settings"))
	if err != nil || json.Unmarshal(raw, &settings) != nil || settings.APIKeyHelper == "" {
		return result(true, nil, "no apiKeyHelper in --settings")
	}
	token, err := exec.Command("/bin/sh", "-c", settings.APIKeyHelper).Output()
	if err != nil {
		return result(true, nil, "apiKeyHelper failed: "+err.Error())
	}
	body, _ := json.Marshal(map[string]interface{}{
		"model":      flag("--model"),
		"max_tokens": 1024,
		"system":     []map[string]interface{}{{"type": "text", "text": flag("--system-prompt")}},
		"messages":   []map[string]interface{}{{"role": "user", "content": []map[string]interface{}{{"type": "text", "text": string(prompt)}}}},
		"tools":      []interface{}{},
		"stream":     false,
	})
	request, _ := http.NewRequest(http.MethodPost, strings.TrimRight(os.Getenv("ANTHROPIC_BASE_URL"), "/")+"/v1/messages?beta=true", bytes.NewReader(body))
	request.Header.Set("content-type", "application/json")
	request.Header.Set("anthropic-version", "2023-06-01")
	// What the real one sends for an apiKeyHelper's output: the Bearer header, and no x-api-key.
	request.Header.Set("authorization", "Bearer "+strings.TrimSpace(string(token)))
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return result(true, nil, "API Error: Connection error.")
	}
	defer response.Body.Close()
	answer, _ := io.ReadAll(response.Body)
	if response.StatusCode != http.StatusOK {
		return result(true, response.StatusCode, fmt.Sprintf("API Error: %d %s", response.StatusCode, answer))
	}
	var message struct {
		Content []struct {
			Text string `json:"text"`
		} `json:"content"`
		Usage map[string]int `json:"usage"`
	}
	if json.Unmarshal(answer, &message) != nil || len(message.Content) == 0 {
		return result(true, nil, "an answer with no text")
	}
	// What the real one reports of a call it made: the endpoint's usage, on the result line.
	out, _ := json.Marshal(map[string]interface{}{
		"type": "result", "subtype": "success", "is_error": false, "api_error_status": nil, "result": message.Content[0].Text,
		"usage": message.Usage,
	})
	if flag("--output-format") == "stream-json" {
		// --include-partial-messages: the answer as it arrives, a delta at a time, written out as it comes,
		// then the whole message and the result line — the order the real one writes them in.
		emit := func(v interface{}) {
			line, _ := json.Marshal(v)
			_, _ = os.Stdout.Write(append(line, '\n'))
			_ = os.Stdout.Sync()
		}
		emit(map[string]interface{}{"type": "system", "subtype": "init", "model": flag("--model")})
		text := []rune(message.Content[0].Text)
		for start := 0; start < len(text); start += 400 {
			end := start + 400
			if end > len(text) {
				end = len(text)
			}
			emit(map[string]interface{}{"type": "stream_event", "event": map[string]interface{}{"type": "content_block_delta", "index": 0,
				"delta": map[string]interface{}{"type": "text_delta", "text": string(text[start:end])}}})
			time.Sleep(2 * time.Millisecond)
		}
		emit(map[string]interface{}{"type": "assistant", "message": map[string]interface{}{"role": "assistant",
			"content": []map[string]interface{}{{"type": "text", "text": message.Content[0].Text}}}})
	}
	fmt.Println(string(out))
	return 0
}

// fakeVerifyClaude writes the shim and points the command at it; the spawns are read back after.
func fakeVerifyClaude(t *testing.T) (spawns func() []fakeVerifySpawn) {
	t.Helper()
	base := t.TempDir()
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	shim := filepath.Join(base, "claude")
	script := "#!/bin/sh\n" + fakeVerifyClaudeDirEnv + "='" + base + "' exec '" + self + "' \"$@\"\n"
	if err := os.WriteFile(shim, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	previous := wikiVerifyClaudeBinary
	wikiVerifyClaudeBinary = shim
	t.Cleanup(func() { wikiVerifyClaudeBinary = previous })
	return func() []fakeVerifySpawn {
		raw, _ := os.ReadFile(filepath.Join(base, "spawns.jsonl"))
		var out []fakeVerifySpawn
		scanner := bufio.NewScanner(bytes.NewReader(raw))
		scanner.Buffer(make([]byte, 1<<20), 1<<24)
		for scanner.Scan() {
			var spawn fakeVerifySpawn
			if err := json.Unmarshal(scanner.Bytes(), &spawn); err != nil {
				t.Fatalf("bad spawn record: %v", err)
			}
			out = append(out, spawn)
		}
		return out
	}
}

// fakeVLLMRequest is one request that reached the model endpoint.
type fakeVLLMRequest struct {
	Path, Authorization, APIKey, Model, System, Prompt string
	Tools                                              int
	Stream                                             bool
	// What the request asked the model to think with: its thinking block, verbatim, and the effort
	// its output_config names. vLLM hands the effort to the chat template as reasoning_effort.
	Thinking json.RawMessage
	Effort   string
}

// thinks reports whether the request turns the model's thinking on: a thinking block of any type
// but disabled, or an effort.
func (r fakeVLLMRequest) thinks() bool {
	if r.Effort != "" {
		return true
	}
	var thinking struct {
		Type string `json:"type"`
	}
	if len(r.Thinking) == 0 || string(r.Thinking) == "null" {
		return false
	}
	return json.Unmarshal(r.Thinking, &thinking) != nil || thinking.Type != "disabled"
}

// fakeVLLM is the model endpoint: /health, and /v1/messages answered by answer(prompt) — a status and
// the text of the model's reply — streamed or not, as the caller asked.
type fakeVLLM struct {
	URL      string
	mu       sync.Mutex
	requests []fakeVLLMRequest
}

func newFakeVLLM(t *testing.T, answer func(prompt string) (int, string)) *fakeVLLM {
	t.Helper()
	f := &fakeVLLM{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			w.WriteHeader(http.StatusOK)
			return
		}
		if r.Method != http.MethodPost || r.URL.Path != "/v1/messages" {
			// The real CLI checks the endpoint before it asks anything (HEAD /api/hello).
			w.WriteHeader(http.StatusOK)
			return
		}
		var body struct {
			Model    string          `json:"model"`
			Stream   bool            `json:"stream"`
			Tools    []interface{}   `json:"tools"`
			System   json.RawMessage `json:"system"`
			Thinking json.RawMessage `json:"thinking"`
			Output   struct {
				Effort string `json:"effort"`
			} `json:"output_config"`
			Messages []struct {
				Role    string          `json:"role"`
				Content json.RawMessage `json:"content"`
			} `json:"messages"`
		}
		raw, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(raw, &body); err != nil {
			t.Errorf("the endpoint was sent a body that is not JSON: %s", raw)
		}
		// The user's turns: the real CLI follows the prompt with a mid-conversation system message
		// (today's date), so the last message is not where the prompt is.
		turns := []string{}
		for _, message := range body.Messages {
			if message.Role == "user" {
				turns = append(turns, messageText(message.Content))
			}
		}
		prompt := strings.Join(turns, "\n")
		f.mu.Lock()
		f.requests = append(f.requests, fakeVLLMRequest{
			Path: r.URL.RequestURI(), Authorization: r.Header.Get("Authorization"), APIKey: r.Header.Get("X-Api-Key"),
			Model: body.Model, System: string(body.System), Prompt: prompt, Tools: len(body.Tools), Stream: body.Stream,
			Thinking: body.Thinking, Effort: body.Output.Effort,
		})
		f.mu.Unlock()
		status, text := answer(prompt)
		if status != http.StatusOK {
			w.Header().Set("content-type", "application/json")
			w.WriteHeader(status)
			_, _ = w.Write([]byte(`{"type":"error","error":{"type":"authentication_error","message":"invalid token"}}`))
			return
		}
		if !body.Stream {
			out, _ := json.Marshal(map[string]interface{}{
				"id": "msg_verify", "type": "message", "role": "assistant", "model": body.Model,
				"content":     []map[string]interface{}{{"type": "text", "text": text}},
				"stop_reason": "end_turn", "usage": map[string]int{"input_tokens": 50, "output_tokens": 20},
			})
			w.Header().Set("content-type", "application/json")
			_, _ = w.Write(out)
			return
		}
		w.Header().Set("content-type", "text/event-stream")
		event := func(name string, data interface{}) {
			payload, _ := json.Marshal(data)
			_, _ = fmt.Fprintf(w, "event: %s\ndata: %s\n\n", name, payload)
		}
		event("message_start", map[string]interface{}{"type": "message_start", "message": map[string]interface{}{
			"id": "msg_verify", "type": "message", "role": "assistant", "model": body.Model, "content": []interface{}{},
			"stop_reason": nil, "stop_sequence": nil, "usage": map[string]int{"input_tokens": 50, "output_tokens": 1},
		}})
		event("content_block_start", map[string]interface{}{"type": "content_block_start", "index": 0, "content_block": map[string]string{"type": "text", "text": ""}})
		event("content_block_delta", map[string]interface{}{"type": "content_block_delta", "index": 0, "delta": map[string]string{"type": "text_delta", "text": text}})
		event("content_block_stop", map[string]interface{}{"type": "content_block_stop", "index": 0})
		event("message_delta", map[string]interface{}{"type": "message_delta", "delta": map[string]interface{}{"stop_reason": "end_turn", "stop_sequence": nil}, "usage": map[string]int{"output_tokens": 20}})
		event("message_stop", map[string]string{"type": "message_stop"})
	}))
	t.Cleanup(srv.Close)
	f.URL = srv.URL
	return f
}

func (f *fakeVLLM) Requests() []fakeVLLMRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]fakeVLLMRequest{}, f.requests...)
}

// messageText is a user message's text, whether it came as a string or as blocks.
func messageText(raw json.RawMessage) string {
	var text string
	if json.Unmarshal(raw, &text) == nil {
		return text
	}
	var blocks []struct {
		Text string `json:"text"`
	}
	_ = json.Unmarshal(raw, &blocks)
	parts := make([]string, 0, len(blocks))
	for _, block := range blocks {
		parts = append(parts, block.Text)
	}
	return strings.Join(parts, "\n")
}

// fakeVerifyDoor is the runner door's two verification routes: a list of ops, and a report that
// records every verdict and answers each as the server would.
type fakeVerifyDoor struct {
	URL        string
	mu         sync.Mutex
	items      []map[string]interface{}
	listMode   string
	reportMode string
	refuse     bool
	lists      []string
	sessions   []string
	verdicts   []map[string]interface{}
}

func newFakeVerifyDoor(t *testing.T, items []map[string]interface{}) *fakeVerifyDoor {
	t.Helper()
	door := &fakeVerifyDoor{items: items, listMode: "automatic", reportMode: "automatic"}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		door.mu.Lock()
		defer door.mu.Unlock()
		door.sessions = append(door.sessions, r.Header.Get("X-Orbit-Session-Id"))
		w.Header().Set("content-type", "application/json")
		if !strings.HasPrefix(r.URL.Path, "/api/runner/wiki/spaces/space-1/verifications") {
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"message":"Cannot GET"}`))
			return
		}
		if r.Method == http.MethodGet {
			door.lists = append(door.lists, r.URL.RequestURI())
			out, _ := json.Marshal(map[string]interface{}{"spaceId": "space-1", "mode": door.listMode, "items": door.items, "next": nil})
			_, _ = w.Write(out)
			return
		}
		var body struct {
			Verdicts []map[string]interface{} `json:"verdicts"`
		}
		raw, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(raw, &body); err != nil {
			t.Errorf("a report that is not JSON: %s", raw)
		}
		outcomes := []map[string]interface{}{}
		for _, verdict := range body.Verdicts {
			door.verdicts = append(door.verdicts, verdict)
			if door.refuse {
				outcomes = append(outcomes, map[string]interface{}{"opId": verdict["opId"], "status": "refused", "httpStatus": 409,
					"message": "this space is tiered now, not automatic, so no verdict is recorded"})
				continue
			}
			outcome := map[string]interface{}{"opId": verdict["opId"], "verdict": verdict["verdict"], "entryId": "e-" + fmt.Sprint(verdict["opId"])}
			switch verdict["verdict"] {
			case "supported":
				outcome["status"], outcome["trust"], outcome["spotCheck"] = "applied", "auto", false
			case "partial":
				outcome["status"], outcome["trust"], outcome["spotCheck"] = "applied", "unreviewed", false
			case "unsupported":
				outcome["status"] = "rejected"
			case "duplicate":
				outcome["status"], outcome["reinforced"] = "reinforced", true
			}
			outcomes = append(outcomes, outcome)
		}
		out, _ := json.Marshal(map[string]interface{}{"spaceId": "space-1", "mode": door.reportMode, "outcomes": outcomes})
		if door.refuse {
			w.WriteHeader(http.StatusConflict)
		}
		_, _ = w.Write(out)
	}))
	t.Cleanup(srv.Close)
	door.URL = srv.URL
	return door
}

func (d *fakeVerifyDoor) Verdicts() []map[string]interface{} {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]map[string]interface{}{}, d.verdicts...)
}

// verifyItem is one op of the list, citing one record, with the neighbours given.
func verifyItem(opID, title string, similar ...map[string]interface{}) map[string]interface{} {
	return map[string]interface{}{
		"opId": opID, "changesetId": "cs-1", "op": "add", "entryId": nil,
		"entry": map[string]interface{}{
			"kind": "pitfall", "title": title, "summary": "What " + strings.ToLower(title) + " means.",
			"fields": map[string]interface{}{"symptom": "It went wrong.", "fix": "Do the other thing."}, "topics": []string{}, "aliases": []string{},
		},
		"sources": []map[string]interface{}{{
			"kind": "tool_call", "ref": "tc-" + opID, "quote": "it went wrong",
			"text": "The build said: it went wrong, and " + title + " was the reason.", "truncated": false,
		}},
		"similar": append([]map[string]interface{}{}, similar...),
	}
}

// wikiVerifySession points the CLI at the door and the model endpoint, as a session on the local
// model's provider would have them — and plants what must NOT reach the clean call.
func wikiVerifySession(t *testing.T, door *fakeVerifyDoor, vllm *fakeVLLM) {
	t.Helper()
	home := t.TempDir()
	if err := os.Chmod(home, 0o700); err != nil {
		t.Fatal(err)
	}
	config := `{"serverUrl":` + strconv.Quote(door.URL) + `,"runnerId":"r1","runnerToken":"runner-token","name":"test"}`
	if err := os.WriteFile(filepath.Join(home, "config.json"), []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ORBIT_HOME", home)
	t.Setenv("ORBIT_SESSION_ID", "caller-session")
	t.Setenv(envWiki, "on")
	t.Setenv("ANTHROPIC_BASE_URL", vllm.URL)
	t.Setenv("ANTHROPIC_AUTH_TOKEN", "tok-local-vllm")
	t.Setenv("ANTHROPIC_MODEL", "qwen3.8-27b-fp8")
	t.Setenv("CLAUDE_CODE_MAX_CONTEXT_TOKENS", "131072")
	// Planted: a bare run would send this as x-api-key; a session's own Claude Code socket; Orbit's own;
	// and the effort and thinking budget a provider may declare for the session's own work.
	t.Setenv("ANTHROPIC_API_KEY", "sk-must-not-reach-the-verifier")
	t.Setenv("CLAUDE_CODE_MESSAGING_SOCKET", "/tmp/the-session-own-socket.sock")
	t.Setenv("ORBIT_BG_TOKEN", "bg-token-must-not-leak")
	t.Setenv("CLAUDE_CODE_EFFORT_LEVEL", "high")
	t.Setenv("MAX_THINKING_TOKENS", "31999")
}

// scriptedVerdicts answers each op by its title, as a model would, in the shapes models answer in.
func scriptedVerdicts(prompt string) (int, string) {
	switch {
	case strings.Contains(prompt, "Supported claim"):
		return http.StatusOK, `{"verdict": "supported", "reason": "The tool output says exactly this."}`
	case strings.Contains(prompt, "Partial claim"):
		return http.StatusOK, "Half of it is in the record.\n```json\n{\"verdict\": \"partial\", \"reason\": \"Only the symptom is in the record.\"}\n```"
	case strings.Contains(prompt, "Unsupported claim"):
		return http.StatusOK, `{"verdict": "unsupported", "reason": "Nothing in the record mentions tmpfs.", "duplicateOf": null}`
	case strings.Contains(prompt, "Duplicate claim"):
		return http.StatusOK, `{"verdict": "duplicate", "reason": "The space already says this.", "duplicateOf": "entry-closed-sets"}`
	}
	return http.StatusOK, "I cannot tell."
}

func fourOps() []map[string]interface{} {
	neighbour := map[string]interface{}{"id": "entry-closed-sets", "kind": "convention", "title": "Closed sets are CHECK constraints", "status": "active", "trust": "auto"}
	rejected := map[string]interface{}{"id": "entry-rejected", "kind": "convention", "title": "Closed sets are enums", "status": "rejected", "trust": "proposed"}
	return []map[string]interface{}{
		verifyItem("op-1", "Supported claim"),
		verifyItem("op-2", "Partial claim"),
		verifyItem("op-3", "Unsupported claim"),
		verifyItem("op-4", "Duplicate claim", neighbour, rejected),
	}
}

// ── The four verdicts ───────────────────────────────────────────────────────────────────────────

func TestWikiVerifyReportsTheVerdictTheModelGaveForEachOp(t *testing.T) {
	door := newFakeVerifyDoor(t, fourOps())
	vllm := newFakeVLLM(t, scriptedVerdicts)
	spawns := fakeVerifyClaude(t)
	wikiVerifySession(t, door, vllm)

	var out strings.Builder
	if err := cmdWikiCLI([]string{"verify", "--space", "space-1"}, strings.NewReader(""), &out); err != nil {
		t.Fatalf("orbit wiki verify: %v\n%s", err, out.String())
	}

	// One verdict per op, as the model gave it, each reported as soon as it was read.
	verdicts := door.Verdicts()
	got := [][]interface{}{}
	for _, verdict := range verdicts {
		got = append(got, []interface{}{verdict["opId"], verdict["verdict"], verdict["reason"], verdict["model"], verdict["duplicateOf"]})
	}
	want := [][]interface{}{
		{"op-1", "supported", "The tool output says exactly this.", "qwen3.8-27b-fp8", nil},
		{"op-2", "partial", "Only the symptom is in the record.", "qwen3.8-27b-fp8", nil},
		{"op-3", "unsupported", "Nothing in the record mentions tmpfs.", "qwen3.8-27b-fp8", nil},
		{"op-4", "duplicate", "The space already says this.", "qwen3.8-27b-fp8", "entry-closed-sets"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("reported verdicts =\n%#v\nwant\n%#v", got, want)
	}
	if n := len(spawns()); n != 4 {
		t.Errorf("Claude Code ran %d times, want one clean call per op", n)
	}
	for _, session := range door.sessions {
		if session != "caller-session" {
			t.Errorf("a request went to the door as %q, not as the session that proposed", session)
		}
	}
	for _, phrase := range []string{
		"supported — applied as Auto, and pushed",
		"partial — applied as Unreviewed",
		"unsupported — rejected: Nothing in the record mentions tmpfs.",
		"duplicate — a duplicate of entry-closed-sets: its sources were added there",
		"Verified 4 of 4 with qwen3.8-27b-fp8 in space space-1: 1 supported, 1 partial, 1 unsupported, 1 duplicate.",
	} {
		if !strings.Contains(out.String(), phrase) {
			t.Errorf("the output does not say %q:\n%s", phrase, out.String())
		}
	}

	// The model was asked once per op, with the Bearer token and nothing else, and no tools.
	requests := vllm.Requests()
	if len(requests) != 4 {
		t.Fatalf("the model endpoint was asked %d times, want once per op", len(requests))
	}
	for i, request := range requests {
		if request.Authorization != "Bearer tok-local-vllm" {
			t.Errorf("request %d authorized as %q: the token goes through the apiKeyHelper as a Bearer", i, request.Authorization)
		}
		// Never ANTHROPIC_API_KEY: an x-api-key, where one goes out at all, is the helper's same token.
		if request.APIKey != "" && request.APIKey != "tok-local-vllm" {
			t.Errorf("request %d carried x-api-key %q, which is not the provider's token", i, request.APIKey)
		}
		if request.Model != "qwen3.8-27b-fp8" || request.Tools != 0 {
			t.Errorf("request %d = model %q with %d tools", i, request.Model, request.Tools)
		}
		if !strings.Contains(request.System, "You verify proposed wiki entries") {
			t.Errorf("request %d's system prompt is not the verifier's own: %s", i, request.System)
		}
	}
	// What the model is handed: the entry, the text of what it cites, and only the LIVE neighbours.
	dup := requests[3].Prompt
	for _, part := range []string{"Duplicate claim", "## The entry (a pitfall)", "The build said: it went wrong", `The proposer quoted: "it went wrong"`,
		"- id entry-closed-sets: [convention] Closed sets are CHECK constraints", `"duplicateOf"`} {
		if !strings.Contains(dup, part) {
			t.Errorf("the prompt does not carry %q:\n%s", part, dup)
		}
	}
	if strings.Contains(dup, "entry-rejected") {
		t.Errorf("a rejected neighbour was offered as something to duplicate:\n%s", dup)
	}
}

// ── The clean launch ────────────────────────────────────────────────────────────────────────────

func TestWikiVerifyLaunchesAClaudeCodeWithNothingOfTheSessionInIt(t *testing.T) {
	door := newFakeVerifyDoor(t, fourOps()[:1])
	vllm := newFakeVLLM(t, scriptedVerdicts)
	spawns := fakeVerifyClaude(t)
	wikiVerifySession(t, door, vllm)
	realHome, _ := os.UserHomeDir()

	if err := cmdWikiCLI([]string{"verify", "--space", "space-1"}, strings.NewReader(""), io.Discard); err != nil {
		t.Fatalf("orbit wiki verify: %v", err)
	}
	runs := spawns()
	if len(runs) != 1 {
		t.Fatalf("Claude Code ran %d times, want once", len(runs))
	}
	run := runs[0]
	// The argv, flag for flag: bare, no tools, no MCP server at all, no session file, JSON out.
	args := run.Args
	settings := ""
	for i, arg := range args {
		if arg == "--settings" && i+1 < len(args) {
			settings = args[i+1]
		}
	}
	if want := wikiVerifyClaudeArgs("qwen3.8-27b-fp8", settings); !reflect.DeepEqual(args, want) {
		t.Fatalf("argv = %#v\nwant %#v", args, want)
	}
	for _, pair := range [][2]string{{"--tools", ""}, {"--mcp-config", `{"mcpServers":{}}`}, {"--output-format", "json"}} {
		found := false
		for i := 0; i+1 < len(args); i++ {
			if args[i] == pair[0] && args[i+1] == pair[1] {
				found = true
			}
		}
		if !found {
			t.Errorf("argv does not pass %s %q", pair[0], pair[1])
		}
	}
	for _, flag := range []string{"-p", "--bare", "--strict-mcp-config", "--no-session-persistence"} {
		if !contains(args, flag) {
			t.Errorf("argv does not pass %s", flag)
		}
	}
	if !strings.Contains(run.Prompt, "Supported claim") {
		t.Errorf("the prompt did not arrive on stdin: %q", run.Prompt)
	}

	// The environment: its own empty HOME and config dir, the provider's endpoint, token, model window
	// — and not one thing of the session's besides.
	env := map[string]string{}
	for _, pair := range run.Env {
		if key, value, ok := strings.Cut(pair, "="); ok {
			env[key] = value
		}
	}
	for key, value := range env {
		switch {
		case key == fakeVerifyClaudeDirEnv:
			// The shim's own marker.
		case strings.HasPrefix(key, "ORBIT_"):
			t.Errorf("the session's %s=%s reached the clean call", key, value)
		case strings.HasPrefix(key, "CLAUDE_CODE_") && key != "CLAUDE_CODE_MAX_CONTEXT_TOKENS" && key != "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC" && key != "CLAUDE_CODE_EFFORT_LEVEL":
			t.Errorf("the session's own Claude Code variable %s=%s reached the clean call", key, value)
		}
	}
	// Its own effort, never the session's: none, and no thinking.
	if env["CLAUDE_CODE_EFFORT_LEVEL"] != "unset" || env["MAX_THINKING_TOKENS"] != "0" {
		t.Errorf("CLAUDE_CODE_EFFORT_LEVEL=%q MAX_THINKING_TOKENS=%q: want unset and 0, whatever the session declares",
			env["CLAUDE_CODE_EFFORT_LEVEL"], env["MAX_THINKING_TOKENS"])
	}
	if _, leaked := env["ANTHROPIC_API_KEY"]; leaked {
		t.Error("ANTHROPIC_API_KEY reached the clean call: a bare run would send it as x-api-key, which vLLM answers 401")
	}
	if env["ANTHROPIC_AUTH_TOKEN"] != "tok-local-vllm" || env["ANTHROPIC_BASE_URL"] != vllm.URL || env["CLAUDE_CODE_MAX_CONTEXT_TOKENS"] != "131072" {
		t.Errorf("the provider's endpoint, token and window did not reach it: %v", env)
	}
	home, config := env["HOME"], env["CLAUDE_CONFIG_DIR"]
	if home == "" || config == "" || home == realHome || filepath.Dir(home) != filepath.Dir(config) || filepath.Dir(home) != run.Cwd {
		t.Errorf("HOME=%q CLAUDE_CONFIG_DIR=%q cwd=%q: want two fresh dirs of one scratch dir it runs in", home, config, run.Cwd)
	}
	if raw, err := os.ReadFile(settings); err == nil {
		t.Errorf("the settings file %s outlived the call: %s", settings, raw)
	}
	if _, err := os.Stat(run.Cwd); !os.IsNotExist(err) {
		t.Errorf("the scratch dir %s outlived the call", run.Cwd)
	}
}

// ── Thinking, only when asked for ───────────────────────────────────────────────────────────────

// The clean call's environment decides whether Claude Code asks the model to think (contract
// `agentSurface.verify.thinking`): by default it says no effort and no thinking, whatever the session's
// provider declared; --effort names one, and nothing else of the session's rides along with it.
func TestWikiVerifyThinksOnlyWhenAskedTo(t *testing.T) {
	door := newFakeVerifyDoor(t, fourOps()[:1])
	vllm := newFakeVLLM(t, scriptedVerdicts)
	spawns := fakeVerifyClaude(t)
	wikiVerifySession(t, door, vllm)
	envOf := func(run fakeVerifySpawn) map[string]string {
		env := map[string]string{}
		for _, pair := range run.Env {
			if key, value, ok := strings.Cut(pair, "="); ok {
				env[key] = value
			}
		}
		return env
	}

	if err := cmdWikiCLI([]string{"verify", "--space", "space-1"}, strings.NewReader(""), io.Discard); err != nil {
		t.Fatalf("orbit wiki verify: %v", err)
	}
	if err := cmdWikiCLI([]string{"verify", "--space", "space-1", "--effort", "high"}, strings.NewReader(""), io.Discard); err != nil {
		t.Fatalf("orbit wiki verify --effort high: %v", err)
	}
	runs := spawns()
	if len(runs) != 2 {
		t.Fatalf("Claude Code ran %d times, want twice", len(runs))
	}
	if env := envOf(runs[0]); env["CLAUDE_CODE_EFFORT_LEVEL"] != "unset" || env["MAX_THINKING_TOKENS"] != "0" {
		t.Errorf("by default: CLAUDE_CODE_EFFORT_LEVEL=%q MAX_THINKING_TOKENS=%q, want unset and 0", env["CLAUDE_CODE_EFFORT_LEVEL"], env["MAX_THINKING_TOKENS"])
	}
	env := envOf(runs[1])
	if env["CLAUDE_CODE_EFFORT_LEVEL"] != "high" {
		t.Errorf("--effort high: CLAUDE_CODE_EFFORT_LEVEL=%q, want high", env["CLAUDE_CODE_EFFORT_LEVEL"])
	}
	if value, ok := env["MAX_THINKING_TOKENS"]; ok {
		t.Errorf("--effort high still handed the child MAX_THINKING_TOKENS=%s: asked to think, it must be let", value)
	}

	for _, bad := range []string{"bogus", "unset", "HIGH"} {
		err := cmdWikiCLI([]string{"verify", "--space", "space-1", "--effort", bad}, strings.NewReader(""), io.Discard)
		if err == nil || !strings.Contains(err.Error(), "--effort must be one of low, medium, high, xhigh, max") {
			t.Errorf("--effort %s: err = %v, want it refused, naming the levels", bad, err)
		}
	}
	if got := len(spawns()); got != 2 {
		t.Errorf("a refused --effort still ran Claude Code (%d runs)", got)
	}
}

// TestWikiVerifyLeavesThinkingOff drives the real Claude Code, because only it decides what goes into
// the request: to a custom endpoint's model it does not know, it sends output_config.effort "high"
// and thinking {type: adaptive} of its own accord — on the local model a verdict of a minute and some
// thousand tokens, where one without takes two seconds — and the session's provider may declare an
// effort of its own, planted here by wikiVerifySession. The verifier's request carries neither. The
// control, --effort high, is the same call with thinking asked for, so the probe is seen to see it.
func TestWikiVerifyLeavesThinkingOff(t *testing.T) {
	exe := requireRealClaude(t)
	door := newFakeVerifyDoor(t, fourOps()[:1])
	vllm := newFakeVLLM(t, scriptedVerdicts)
	wikiVerifySession(t, door, vllm)
	previous := wikiVerifyClaudeBinary
	wikiVerifyClaudeBinary = exe
	t.Cleanup(func() { wikiVerifyClaudeBinary = previous })

	var out strings.Builder
	if err := cmdWikiCLI([]string{"verify", "--space", "space-1"}, strings.NewReader(""), &out); err != nil {
		t.Fatalf("orbit wiki verify with %s: %v\n%s", exe, err, out.String())
	}
	requests := vllm.Requests()
	if len(requests) != 1 {
		t.Fatalf("the real Claude Code asked the endpoint %d times, want once", len(requests))
	}
	if requests[0].thinks() {
		t.Errorf("the verifier's request turns thinking on: thinking=%s effort=%q", requests[0].Thinking, requests[0].Effort)
	}
	if verdicts := door.Verdicts(); len(verdicts) != 1 || verdicts[0]["verdict"] != "supported" {
		t.Fatalf("verdicts = %#v: the call without thinking is still read as a verdict", verdicts)
	}

	out.Reset()
	if err := cmdWikiCLI([]string{"verify", "--space", "space-1", "--effort", "high"}, strings.NewReader(""), &out); err != nil {
		t.Fatalf("orbit wiki verify --effort high with %s: %v\n%s", exe, err, out.String())
	}
	requests = vllm.Requests()
	if len(requests) != 2 {
		t.Fatalf("the real Claude Code asked the endpoint %d times, want twice", len(requests))
	}
	if !requests[1].thinks() || requests[1].Effort != "high" {
		t.Errorf("--effort high did not ask for thinking (thinking=%s effort=%q): the probe above cannot tell on from off",
			requests[1].Thinking, requests[1].Effort)
	}
}

// ── What is not a verdict ───────────────────────────────────────────────────────────────────────

func TestWikiVerifyReportsNothingForAnAnswerThatIsNotAVerdict(t *testing.T) {
	neighbour := map[string]interface{}{"id": "entry-closed-sets", "kind": "convention", "title": "Closed sets", "status": "active"}
	items := []map[string]interface{}{
		verifyItem("op-prose", "Prose claim"),
		verifyItem("op-maybe", "Maybe claim"),
		verifyItem("op-stray", "Stray duplicate claim", neighbour),
		verifyItem("op-mute", "Reasonless claim"),
		verifyItem("op-mixed", "Mixed claim", neighbour),
	}
	door := newFakeVerifyDoor(t, items)
	vllm := newFakeVLLM(t, func(prompt string) (int, string) {
		switch {
		case strings.Contains(prompt, "Prose claim"):
			return http.StatusOK, "I think the records support it, mostly."
		case strings.Contains(prompt, "Maybe claim"):
			return http.StatusOK, `{"verdict": "maybe", "reason": "Hard to say."}`
		case strings.Contains(prompt, "Stray duplicate claim"):
			return http.StatusOK, `{"verdict": "duplicate", "reason": "Seen it.", "duplicateOf": "entry-nobody-listed"}`
		case strings.Contains(prompt, "Reasonless claim"):
			return http.StatusOK, `{"verdict": "supported"}`
		}
		return http.StatusOK, `{"verdict": "supported", "reason": "Fine.", "duplicateOf": "entry-closed-sets"}`
	})
	spawns := fakeVerifyClaude(t)
	wikiVerifySession(t, door, vllm)

	var out strings.Builder
	err := cmdWikiCLI([]string{"verify", "--space", "space-1", "--json"}, strings.NewReader(""), &out)
	if err == nil || !strings.Contains(err.Error(), "5 ops were left without a verdict") {
		t.Fatalf("five unreadable answers = %v, want the command to fail naming them", err)
	}
	if verdicts := door.Verdicts(); len(verdicts) != 0 {
		t.Fatalf("an answer that is not a verdict was reported anyway: %#v", verdicts)
	}
	if len(spawns()) != 5 {
		t.Errorf("Claude Code ran %d times, want once per op", len(spawns()))
	}
	var summary wikiVerifySummary
	if err := json.Unmarshal([]byte(out.String()), &summary); err != nil {
		t.Fatalf("--json printed something that is not the summary: %v (%q)", err, out.String())
	}
	if summary.Looked != 5 || summary.Verified != 0 || summary.Failed != 5 || len(summary.Failures) != 5 {
		t.Errorf("summary = %+v", summary)
	}
	for _, failure := range summary.Failures {
		if !strings.Contains(failure.Why, "is not a verdict") {
			t.Errorf("failure %s says %q", failure.OpID, failure.Why)
		}
	}
}

func TestWikiVerifyParsesOnlyAVerdict(t *testing.T) {
	candidates := []wikiVerifyCandidate{{ID: "e1", Kind: "pitfall", Title: "An entry"}}
	for _, tc := range []struct {
		text    string
		verdict string
		refuse  string
	}{
		{text: `{"verdict":"supported","reason":"Yes."}`, verdict: "supported"},
		{text: "Thinking it over: {not json}.\n{\"verdict\":\"partial\",\"reason\":\"Half.\"}", verdict: "partial"},
		{text: "```json\n{\"verdict\": \"unsupported\", \"reason\": \"No.\", \"duplicateOf\": \"\"}\n```", verdict: "unsupported"},
		{text: `{"verdict":"duplicate","reason":"Same.","duplicateOf":"e1"}`, verdict: "duplicate"},
		{text: "Supported.", refuse: "no JSON object"},
		{text: `{"verdict":"Supported ","reason":"Yes."}`, refuse: "verdict is not one of"},
		{text: `{"verdict":"supported","reason":"   "}`, refuse: "no reason"},
		{text: `{"verdict":"duplicate","reason":"Same."}`, refuse: "must name one of the listed entries"},
		{text: `{"verdict":"duplicate","reason":"Same.","duplicateOf":"e2"}`, refuse: "must name one of the listed entries"},
		{text: `{"verdict":"partial","reason":"Half.","duplicateOf":"e1"}`, refuse: "only a duplicate does"},
		{text: `{"reason":"No verdict here."}`, refuse: "no JSON object"},
	} {
		got, err := parseWikiVerdict(tc.text, candidates)
		if tc.refuse != "" {
			if err == nil || !strings.Contains(err.Error(), tc.refuse) {
				t.Errorf("%q = %+v, %v; want refused for %q", tc.text, got, err, tc.refuse)
			}
			continue
		}
		if err != nil || got.Verdict != tc.verdict {
			t.Errorf("%q = %+v, %v; want %s", tc.text, got, err, tc.verdict)
		}
	}
	long, err := parseWikiVerdict(`{"verdict":"supported","reason":"`+strings.Repeat("é", 600)+`"}`, nil)
	if err != nil || len([]rune(long.Reason)) != wikiVerifyReasonMaxChars {
		t.Errorf("a long reason = %d characters, %v; want it cut to what the server keeps", len([]rune(long.Reason)), err)
	}
}

// A maintenance run asks again about an op whose answer was not a verdict, saying why and which ids duplicateOf
// may be — none, when no entry is listed — and reads the new answer as strictly as the first.
func TestWikiVerifyAsksAgainSayingWhyTheLastAnswerWasNotTaken(t *testing.T) {
	refused := `a duplicate must name one of the listed entries, and "entry-gone" is not one`
	listed := []wikiVerifyCandidate{{ID: "entry-a", Kind: "pitfall", Title: "A"}, {ID: "entry-b", Kind: "convention", Title: "B"}}
	again := wikiVerifyRetrySuffix(refused, listed)
	for _, part := range []string{
		"## Your last answer was not taken",
		"your answer was not a verdict: " + refused + ".",
		"duplicateOf must be one of these ids, copied exactly: entry-a, entry-b.",
		"Answer again, with one JSON object and nothing else.",
	} {
		if !strings.Contains(again, part) {
			t.Errorf("the second asking does not say %q:\n%s", part, again)
		}
	}
	none := wikiVerifyRetrySuffix("no JSON object in it", nil)
	if !strings.Contains(none, "your answer was not a verdict: no JSON object in it.") ||
		!strings.Contains(none, "No entry is listed above, so this entry is no duplicate: answer supported, partial or unsupported") {
		t.Errorf("the second asking with nothing listed:\n%s", none)
	}
	// However it was asked, an answer naming an id that is not listed is still no verdict.
	if _, err := parseWikiVerdict(`{"verdict":"duplicate","reason":"Same.","duplicateOf":"entry-gone"}`, listed); err == nil {
		t.Error("a duplicate of an entry not listed was read as a verdict")
	}
}

// ── What stops a run ────────────────────────────────────────────────────────────────────────────

func TestWikiVerifyStopsAtTheFirst401(t *testing.T) {
	door := newFakeVerifyDoor(t, fourOps())
	vllm := newFakeVLLM(t, func(string) (int, string) { return http.StatusUnauthorized, "" })
	spawns := fakeVerifyClaude(t)
	wikiVerifySession(t, door, vllm)

	var out strings.Builder
	err := cmdWikiCLI([]string{"verify", "--space", "space-1"}, strings.NewReader(""), &out)
	if err == nil || !strings.Contains(err.Error(), "401") || !strings.Contains(err.Error(), "ANTHROPIC_AUTH_TOKEN") {
		t.Fatalf("a 401 = %v, want the run stopped naming the token", err)
	}
	if n := len(spawns()); n != 1 {
		t.Errorf("Claude Code ran %d times: every op after a 401 would be refused the same way, three minutes each", n)
	}
	if len(door.Verdicts()) != 0 {
		t.Errorf("a verdict was reported after a 401: %#v", door.Verdicts())
	}
}

func TestWikiVerifyStopsWhenTheSpaceIsNoLongerAutomatic(t *testing.T) {
	t.Run("before asking the model anything", func(t *testing.T) {
		door := newFakeVerifyDoor(t, fourOps())
		door.listMode = "tiered"
		vllm := newFakeVLLM(t, scriptedVerdicts)
		spawns := fakeVerifyClaude(t)
		wikiVerifySession(t, door, vllm)
		var out strings.Builder
		err := cmdWikiCLI([]string{"verify", "--space", "space-1"}, strings.NewReader(""), &out)
		if err == nil || !strings.Contains(err.Error(), "the space is tiered now, not automatic") {
			t.Fatalf("a tiered space = %v", err)
		}
		if len(spawns()) != 0 || len(vllm.Requests()) != 0 || len(door.Verdicts()) != 0 {
			t.Errorf("the model was asked about a space that no longer lets it decide")
		}
	})
	t.Run("when the server refuses a verdict for it", func(t *testing.T) {
		door := newFakeVerifyDoor(t, fourOps())
		door.refuse, door.reportMode = true, "tiered"
		vllm := newFakeVLLM(t, scriptedVerdicts)
		spawns := fakeVerifyClaude(t)
		wikiVerifySession(t, door, vllm)
		err := cmdWikiCLI([]string{"verify", "--space", "space-1"}, strings.NewReader(""), io.Discard)
		if err == nil || !strings.Contains(err.Error(), "stopped") {
			t.Fatalf("a refused verdict in a space gone tiered = %v", err)
		}
		if len(spawns()) != 1 || len(door.Verdicts()) != 1 {
			t.Errorf("ran %d, reported %d: the run should stop after the first refusal", len(spawns()), len(door.Verdicts()))
		}
	})
	t.Run("when a verdict of its own sends the space back to Tiered", func(t *testing.T) {
		door := newFakeVerifyDoor(t, fourOps())
		door.reportMode = "tiered"
		vllm := newFakeVLLM(t, scriptedVerdicts)
		spawns := fakeVerifyClaude(t)
		wikiVerifySession(t, door, vllm)
		var out strings.Builder
		err := cmdWikiCLI([]string{"verify", "--space", "space-1"}, strings.NewReader(""), &out)
		if err == nil || !strings.Contains(err.Error(), "sent the space back to tiered") {
			t.Fatalf("a verdict that tripped the fallback = %v", err)
		}
		if len(spawns()) != 1 || len(door.Verdicts()) != 1 {
			t.Errorf("ran %d, reported %d: nothing after the trip", len(spawns()), len(door.Verdicts()))
		}
		if !strings.Contains(out.String(), "Verified 1 of 1") {
			t.Errorf("the recorded verdict is not counted: %s", out.String())
		}
	})
}

func TestWikiVerifyTakesTheModelAndItsEndpointFromTheProvider(t *testing.T) {
	door := newFakeVerifyDoor(t, fourOps()[:1])
	vllm := newFakeVLLM(t, scriptedVerdicts)
	spawns := fakeVerifyClaude(t)
	wikiVerifySession(t, door, vllm)

	for _, missing := range []struct{ env, says string }{
		{"ANTHROPIC_BASE_URL", "no endpoint (ANTHROPIC_BASE_URL)"},
		{"ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"},
		{"ANTHROPIC_MODEL", "pass --model"},
	} {
		value := os.Getenv(missing.env)
		t.Setenv(missing.env, "")
		err := cmdWikiCLI([]string{"verify", "--space", "space-1"}, strings.NewReader(""), io.Discard)
		if err == nil || !strings.Contains(err.Error(), missing.says) {
			t.Errorf("without %s = %v", missing.env, err)
		}
		t.Setenv(missing.env, value)
	}
	if len(door.lists) != 0 || len(spawns()) != 0 {
		t.Fatalf("a run with no model to ask read the list or ran Claude Code")
	}
	if err := cmdWikiCLI([]string{"verify"}, strings.NewReader(""), io.Discard); err == nil || !strings.Contains(err.Error(), "--space is required") {
		t.Errorf("no --space = %v", err)
	}

	// --model names another model on the same endpoint.
	if err := cmdWikiCLI([]string{"verify", "--space", "space-1", "--model", "qwen-other"}, strings.NewReader(""), io.Discard); err != nil {
		t.Fatalf("--model: %v", err)
	}
	if requests := vllm.Requests(); len(requests) != 1 || requests[0].Model != "qwen-other" {
		t.Fatalf("--model did not reach the endpoint: %#v", requests)
	}
	if verdicts := door.Verdicts(); len(verdicts) != 1 || verdicts[0]["model"] != "qwen-other" {
		t.Errorf("the verdict does not name the model that gave it: %#v", verdicts)
	}

	// An endpoint that is not there: nothing is read and no model is asked.
	t.Setenv("ANTHROPIC_BASE_URL", "http://127.0.0.1:1")
	before := len(door.lists)
	err := cmdWikiCLI([]string{"verify", "--space", "space-1"}, strings.NewReader(""), io.Discard)
	if err == nil || !strings.Contains(err.Error(), "is not reachable") {
		t.Errorf("a dead endpoint = %v", err)
	}
	if len(door.lists) != before {
		t.Errorf("the list was read with no model to ask")
	}
}

// ── The copy ────────────────────────────────────────────────────────────────────────────────────

// The precondition, word for word, before the mechanics — the wiki_propose rule, for the one wiki
// verb a model could be tempted to do by hand.
func TestWikiVerifyDescriptionIsAPrecondition(t *testing.T) {
	verify := wikiSurface(t)["verify"].(map[string]interface{})
	if verify["precondition"] != wikiVerifyPrecondition {
		t.Fatalf("the precondition this binary ships is not the contract's:\n here: %q\n there: %q", wikiVerifyPrecondition, verify["precondition"])
	}
	if verify["cli"] != "orbit wiki verify" {
		t.Errorf("the contract names %v as the command", verify["cli"])
	}
	// The four verdicts are the contract's, and the model is told exactly those four.
	verdicts := wikiContract(t)["reviewModes"].(map[string]interface{})["verification"].(map[string]interface{})["verdicts"].(map[string]interface{})
	declared := []string{}
	for verdict := range verdicts {
		declared = append(declared, verdict)
	}
	shipped := append([]string{}, wikiVerifyVerdicts...)
	sort.Strings(declared)
	sort.Strings(shipped)
	if !reflect.DeepEqual(declared, shipped) {
		t.Errorf("verdicts here %v, in the contract %v", shipped, declared)
	}
	prompt := wikiVerifyPrompt(wikiVerificationItem{}, nil)
	for _, verdict := range wikiVerifyVerdicts {
		if !strings.Contains(prompt, `"`+verdict+`"`) {
			t.Errorf("the prompt never offers %q", verdict)
		}
	}
	var spec cliCapabilitySpec
	for _, candidate := range wikiCLICapabilities {
		if candidate.Tool == "wiki_verify" {
			spec = candidate
		}
	}
	if spec.Tool == "" || !reflect.DeepEqual(spec.Argv, []string{"orbit", "wiki", "verify"}) || !spec.SessionOnly || !spec.Mutates {
		t.Fatalf("the capability is %#v", spec)
	}
	if !strings.HasPrefix(spec.Description, wikiVerifyPrecondition) {
		t.Errorf("the capability's description does not lead with the precondition: %q", spec.Description)
	}
	// No tool stands beside it, so its schema is its own: exactly the flags its parser takes.
	properties, _ := spec.InputSchema["properties"].(map[string]interface{})
	names := []string{}
	for name := range properties {
		names = append(names, name)
		if !writtenFlagIsParsed("verify", name) {
			t.Errorf("the schema names --%s, which `orbit wiki verify` does not take", name)
		}
	}
	sort.Strings(names)
	if !reflect.DeepEqual(names, []string{"effort", "max", "model", "space"}) || !reflect.DeepEqual(spec.InputSchema["required"], []string{"space"}) {
		t.Errorf("the schema = %#v", spec.InputSchema)
	}
	help := wikiActionHelp["verify"]
	for _, sentence := range strings.Split(wikiVerifyPrecondition, ": ") {
		if !strings.Contains(spec.Description, sentence) || !strings.Contains(help, sentence) {
			t.Errorf("the description or the help does not carry %q", sentence)
		}
	}
	if strings.Index(help, wikiVerifyPrecondition) > strings.Index(help, "Each op this session proposed") {
		t.Error("the help states the mechanics before the precondition")
	}
	for _, phrase := range []string{
		"never write a verdict yourself",
		"a verdict that cannot be read is reported as nothing",
		"supported, partial, unsupported or duplicate",
		"stops at the first 401",
		"exits non-zero when any op it looked at was left without a verdict",
		"does not think unless --effort names a level",
	} {
		if !strings.Contains(spec.Description, phrase) {
			t.Errorf("the description does not say %q", phrase)
		}
	}
	if wikiToolNames["wiki_verify"] {
		t.Error("verify is a runner's work, and no MCP tool")
	}
}

func TestWikiVerifyOffersTheModelOnlyLiveNeighboursAndTheAmendsOwnEntry(t *testing.T) {
	var item wikiVerificationItem
	raw, _ := json.Marshal(map[string]interface{}{
		"opId": "op-a", "op": "amend", "entryId": "entry-self",
		"entry":   map[string]interface{}{"kind": "pitfall", "title": "An amended pitfall", "summary": "Now sharper.", "fields": map[string]interface{}{"fix": "x"}},
		"sources": []map[string]interface{}{{"kind": "commit", "ref": "abc123", "quote": nil, "text": nil, "truncated": false}, {"kind": "tool_call", "ref": "tc", "quote": "q", "text": "long", "truncated": true}},
		"similar": []map[string]interface{}{
			{"id": "entry-live", "kind": "pitfall", "title": "Live", "status": "active"},
			{"id": "entry-proposed", "kind": "pitfall", "title": "Waiting", "status": "proposed"},
			{"id": "entry-self", "kind": "pitfall", "title": "Itself", "status": "active"},
		},
	})
	if err := json.Unmarshal(raw, &item); err != nil {
		t.Fatal(err)
	}
	candidates := wikiVerifyCandidates(item)
	ids := []string{}
	for _, candidate := range candidates {
		ids = append(ids, candidate.ID)
	}
	if !reflect.DeepEqual(ids, []string{"entry-self", "entry-live"}) {
		t.Errorf("candidates = %v, want the amend's own entry and the one live neighbour", ids)
	}
	prompt := wikiVerifyPrompt(item, candidates)
	for _, part := range []string{
		"the change amends entry entry-self", "(the entry this amend changes)", "### Record 1: commit abc123",
		"This record's text is not available", "(The text was cut here.)", `"fix": "x"`,
	} {
		if !strings.Contains(prompt, part) {
			t.Errorf("the prompt does not carry %q:\n%s", part, prompt)
		}
	}
}

// An adopted add whose very content a later op made live is judged that entry's duplicate by the server,
// whatever the model said (contract `reviewModes.verification.adoption.twin`): the line names the entry the
// server found, where a duplicate verdict names the one the model did.
func TestWikiVerifySaysWhichLiveEntryAnAdoptedOpTurnedOutToDuplicate(t *testing.T) {
	twin := describeWikiVerdictOutcome(map[string]interface{}{"status": "reinforced", "entryId": "entry-later", "reinforced": true},
		wikiVerdict{Verdict: "supported", Reason: "The record says so."})
	if twin != "a duplicate of the live entry entry-later, which holds its very content: its sources were added there" {
		t.Errorf("an adopted twin reads %q", twin)
	}
	held := describeWikiVerdictOutcome(map[string]interface{}{"status": "reinforced", "entryId": "entry-later", "reinforced": false},
		wikiVerdict{Verdict: "partial", Reason: "Some of it."})
	if !strings.HasPrefix(held, "a duplicate of the live entry entry-later") || !strings.Contains(held, "its sources were not added") {
		t.Errorf("an adopted twin in a space that reviews every reinforce reads %q", held)
	}
	named := describeWikiVerdictOutcome(map[string]interface{}{"status": "reinforced", "entryId": "entry-named", "reinforced": true},
		wikiVerdict{Verdict: "duplicate", Reason: "Said already.", DuplicateOf: "entry-named"})
	if named != "a duplicate of entry-named: its sources were added there" {
		t.Errorf("a duplicate verdict reads %q", named)
	}
}

// ── The real Claude Code, where this machine has one ────────────────────────────────────────────

// The fake above does what the clean launch should make the real one do. This holds the real one
// to it: the flags are accepted, the apiKeyHelper's token goes out as a Bearer — and, at times, as
// x-api-key as well (Claude Code's documented behaviour for a helper, seen here about one run in
// five), but always the provider's token and never ANTHROPIC_API_KEY — no tool is offered, and the
// verifier's own system prompt is what it is told — against the same fake endpoint, streaming as
// the real one asks it to.
func TestWikiVerifyDrivesTheRealClaudeCodeCleanly(t *testing.T) {
	exe := requireRealClaude(t)
	door := newFakeVerifyDoor(t, fourOps()[:2])
	vllm := newFakeVLLM(t, scriptedVerdicts)
	wikiVerifySession(t, door, vllm)
	previous := wikiVerifyClaudeBinary
	wikiVerifyClaudeBinary = exe
	t.Cleanup(func() { wikiVerifyClaudeBinary = previous })

	var out strings.Builder
	if err := cmdWikiCLI([]string{"verify", "--space", "space-1"}, strings.NewReader(""), &out); err != nil {
		t.Fatalf("orbit wiki verify with %s: %v\n%s", exe, err, out.String())
	}
	verdicts := door.Verdicts()
	if len(verdicts) != 2 || verdicts[0]["verdict"] != "supported" || verdicts[1]["verdict"] != "partial" {
		t.Fatalf("verdicts = %#v", verdicts)
	}
	requests := vllm.Requests()
	if len(requests) != 2 {
		t.Fatalf("the real Claude Code asked the endpoint %d times, want once per op", len(requests))
	}
	for _, request := range requests {
		if request.Authorization != "Bearer tok-local-vllm" || (request.APIKey != "" && request.APIKey != "tok-local-vllm") {
			t.Errorf("authorized with %q / x-api-key %q: want the provider's token as a Bearer, and never ANTHROPIC_API_KEY", request.Authorization, request.APIKey)
		}
		if request.Tools != 0 || request.Model != "qwen3.8-27b-fp8" {
			t.Errorf("offered %d tools on model %q", request.Tools, request.Model)
		}
		if !strings.Contains(request.System, "You verify proposed wiki entries") {
			t.Errorf("the verifier's system prompt did not reach the model: %s", request.System)
		}
		if strings.Contains(request.System, "CLAUDE.md") || len(request.System) > 4_000 {
			t.Errorf("the system prompt carries more than the clean launch should (%d bytes)", len(request.System))
		}
	}
}
