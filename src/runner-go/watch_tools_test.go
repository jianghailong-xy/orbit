package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// watchContract is contracts/watch.contract.json, the file the TypeScript halves read as well.
func watchContract(t *testing.T) map[string]interface{} {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "contracts", "watch.contract.json"))
	if err != nil {
		t.Fatal(err)
	}
	var contract map[string]interface{}
	if err := json.Unmarshal(raw, &contract); err != nil {
		t.Fatal(err)
	}
	return contract
}

// asJSON is a Go value as the wire carries it, for comparing with what the contract file says.
func asJSON(t *testing.T, value interface{}) interface{} {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var out interface{}
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func headlineWatchPredicate(t *testing.T) interface{} {
	t.Helper()
	for _, vector := range watchContract(t)["vectors"].([]interface{}) {
		if v := vector.(map[string]interface{}); v["id"] == "all-terminal-or-any-failed" {
			return v["given"].(map[string]interface{})["predicate"]
		}
	}
	t.Fatal("the contract lost its all-terminal-or-any-failed vector")
	return nil
}

func watchToolText(t *testing.T, result map[string]interface{}) string {
	t.Helper()
	content, _ := result["content"].([]map[string]interface{})
	if len(content) == 0 {
		t.Fatalf("tool result has no content: %#v", result)
	}
	text, _ := content[0]["text"].(string)
	return text
}

// watchRequest is one request the watch door was sent.
type watchRequest struct {
	method, uri, session string
	body                 map[string]interface{}
}

// watchDoor is a runner watch door that records every request and answers each with status and reply.
func watchDoor(t *testing.T, status int, reply string) (*httptest.Server, *[]watchRequest) {
	t.Helper()
	var requests []watchRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		request := watchRequest{method: r.Method, uri: r.URL.RequestURI(), session: r.Header.Get("X-Orbit-Session-Id")}
		if raw, _ := io.ReadAll(r.Body); len(raw) > 0 {
			if err := json.Unmarshal(raw, &request.body); err != nil {
				t.Errorf("%s %s sent a body that is not JSON: %s", r.Method, r.URL.Path, raw)
			}
		}
		requests = append(requests, request)
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(reply))
	}))
	t.Cleanup(srv.Close)
	return srv, &requests
}

func watchMCP(t *testing.T, serverURL string, orchestration bool) *mcpServer {
	t.Helper()
	t.Setenv("ORBIT_HOME", t.TempDir())
	return &mcpServer{
		t:                  NewTransport(serverURL, "runner-token"),
		sessionID:          "caller-session",
		orchestrationToken: "session-token",
		allowOrchestration: orchestration,
	}
}

const activeWatchReply = `{"id":"watch-7","state":"ACTIVE","action":"RESUME_SESSION",` +
	`"expiresAt":"2026-09-15T12:00:00.000Z","createdAt":"2026-09-14T12:00:00.000Z",` +
	`"predicate":{"kind":"ALL","over":"ALL_TARGETS","leaf":"TASK_TERMINAL"},` +
	`"targets":[{"targetKind":"TASK","targetResourceId":"t1","state":"OBSERVED"}],"matches":[]}`

func TestWatchAgentSurfaceIsTheContracts(t *testing.T) {
	contract := watchContract(t)
	surface := contract["agentSurface"].(map[string]interface{})

	families := surface["awaitPresets"].(map[string]interface{})
	for tool, presets := range map[string][]watchAwaitPreset{"task_await": taskAwaitPresets, "session_await": sessionAwaitPresets} {
		family := families[tool].(map[string]interface{})
		until := family["until"].(map[string]interface{})
		if family["default"] != presets[0].until {
			t.Errorf("%s defaults to %s here and to %v in the contract", tool, presets[0].until, family["default"])
		}
		if len(until) != len(presets) {
			t.Errorf("%s offers %d presets here and %d in the contract", tool, len(presets), len(until))
		}
		for _, preset := range presets {
			want, ok := until[preset.until]
			if !ok {
				t.Errorf("%s offers %s, which the contract does not name", tool, preset.until)
				continue
			}
			if got := asJSON(t, preset.predicate); !reflect.DeepEqual(got, want) {
				t.Errorf("%s %s = %#v here, %#v in the contract", tool, preset.until, got, want)
			}
		}
	}
	// The request agents make most is task_await with nothing but the ids.
	if got := asJSON(t, taskAwaitPresets[0].predicate); !reflect.DeepEqual(got, headlineWatchPredicate(t)) {
		t.Errorf("task_await's default = %#v, want the contract's all-terminal-or-any-failed predicate", got)
	}

	wait := surface["sessionCreateWait"].(map[string]interface{})["watch"].(map[string]interface{})
	body := asJSON(t, sessionWaitWatchBody("S1")).(map[string]interface{})
	if !reflect.DeepEqual(body["predicate"], wait["predicate"]) || body["action"] != wait["action"] ||
		body["idempotencyKey"] != strings.Replace(wait["idempotencyKey"].(string), "<sessionId>", "S1", 1) {
		t.Errorf("session_create(wait) records %#v, the contract says %#v", body, wait)
	}

	tools := map[string]bool{}
	for _, tool := range surface["tools"].([]interface{}) {
		tools[tool.(string)] = true
		if !hasMCPTool(toolDescriptors(false, true), tool.(string)) {
			t.Errorf("the contract names %s, and no tool is served under that name", tool)
		}
	}
	if !reflect.DeepEqual(tools, watchToolNames) {
		t.Errorf("watch tools = %v, contract tools = %v", watchToolNames, tools)
	}
	outcomes := surface["release"].(map[string]interface{})["outcomes"].(map[string]interface{})
	for _, outcome := range []string{"CANCELLED", "WAKE_WITHDRAWN", "WAKE_NOT_QUEUED", "ALREADY_WOKEN", "NOTHING_OWED"} {
		if _, ok := outcomes[outcome]; !ok {
			t.Errorf("this binary acts on release outcome %s, which the contract does not name", outcome)
		}
	}
	states := contract["states"].(map[string]interface{})["watch"].(map[string]interface{})["values"]
	if !reflect.DeepEqual(asJSON(t, watchStates), states) {
		t.Errorf("watch states = %v, contract = %v", watchStates, states)
	}
}

func TestTaskAwaitIsOneCallForAllTerminalOrAnyFailed(t *testing.T) {
	srv, requests := watchDoor(t, http.StatusCreated, activeWatchReply)
	mcp := watchMCP(t, srv.URL, false)
	ids := []interface{}{"t1", "t2", "t3", "t4", "t5", "t6", "t7"}
	result := mcp.callTool("task_await", map[string]interface{}{"taskIds": ids})
	text := watchToolText(t, result)
	if result["isError"] == true {
		t.Fatalf("task_await failed: %s", text)
	}
	if len(*requests) != 1 {
		t.Fatalf("requests = %#v, want one create", *requests)
	}
	request := (*requests)[0]
	if request.method != http.MethodPost || request.uri != "/api/runner/watches" || request.session != "caller-session" {
		t.Fatalf("request = %#v", request)
	}
	targets := make([]interface{}, 0, len(ids))
	for _, id := range ids {
		targets = append(targets, map[string]interface{}{"kind": "TASK", "id": id})
	}
	want := map[string]interface{}{
		"predicateVersion": float64(1),
		"predicate":        headlineWatchPredicate(t),
		"targets":          targets,
		"action":           "RESUME_SESSION",
	}
	if !reflect.DeepEqual(request.body, want) {
		t.Fatalf("body = %#v\nwant %#v", request.body, want)
	}
	for _, phrase := range []string{"Watch watch-7 is waiting", "End your turn now", "Do not poll"} {
		if !strings.Contains(text, phrase) {
			t.Errorf("result does not say %q:\n%s", phrase, text)
		}
	}
}

func TestWatchToolsSendWhatWasAskedToTheirRoutes(t *testing.T) {
	cases := []struct {
		name        string
		args        map[string]interface{}
		method, uri string
		body        map[string]interface{}
	}{
		{
			name: "watch_create",
			args: map[string]interface{}{
				"targets": []interface{}{
					map[string]interface{}{"kind": "task", "id": "t1"},
					map[string]interface{}{"kind": "SESSION", "id": "s1"},
				},
				// Models send the object as a string often enough that either is read.
				"predicate":      `{"kind":"ALL","over":"ALL_TARGETS","leaf":"TASK_DONE"}`,
				"action":         "notify_user",
				"ttlSeconds":     float64(600),
				"idempotencyKey": " retry-1 ",
			},
			method: http.MethodPost,
			uri:    "/api/runner/watches",
			body: map[string]interface{}{
				"predicateVersion": float64(1),
				"predicate":        map[string]interface{}{"kind": "ALL", "over": "ALL_TARGETS", "leaf": "TASK_DONE"},
				"targets": []interface{}{
					map[string]interface{}{"kind": "TASK", "id": "t1"},
					map[string]interface{}{"kind": "SESSION", "id": "s1"},
				},
				"action":         "NOTIFY_USER",
				"ttlSeconds":     float64(600),
				"idempotencyKey": "retry-1",
			},
		},
		{name: "watch_get", args: map[string]interface{}{"watchId": "w1"}, method: http.MethodGet, uri: "/api/runner/watches/w1"},
		{name: "watch_list", args: map[string]interface{}{"state": "matched"}, method: http.MethodGet, uri: "/api/runner/watches?state=MATCHED"},
		{
			name:   "watch_update",
			args:   map[string]interface{}{"watchId": "w1", "ttlSeconds": "3600"},
			method: http.MethodPatch,
			uri:    "/api/runner/watches/w1",
			body:   map[string]interface{}{"ttlSeconds": float64(3600)},
		},
		{name: "watch_cancel", args: map[string]interface{}{"watchId": "w1"}, method: http.MethodPost, uri: "/api/runner/watches/w1/cancel"},
		{
			name:   "session_await",
			args:   map[string]interface{}{"sessionIds": []interface{}{"s1", "s1", "s2"}, "until": "any_needs_attention", "ttlSeconds": float64(120)},
			method: http.MethodPost,
			uri:    "/api/runner/watches",
			body: map[string]interface{}{
				"predicateVersion": float64(1),
				"predicate":        map[string]interface{}{"kind": "ANY", "over": "ALL_TARGETS", "leaf": "SESSION_NEEDS_ATTENTION"},
				"targets": []interface{}{
					map[string]interface{}{"kind": "SESSION", "id": "s1"},
					map[string]interface{}{"kind": "SESSION", "id": "s2"},
				},
				"action":     "RESUME_SESSION",
				"ttlSeconds": float64(120),
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv, requests := watchDoor(t, http.StatusOK, activeWatchReply)
			result := watchMCP(t, srv.URL, true).callTool(tc.name, tc.args)
			if result["isError"] == true {
				t.Fatalf("%s failed: %s", tc.name, watchToolText(t, result))
			}
			if len(*requests) != 1 {
				t.Fatalf("requests = %#v, want one", *requests)
			}
			got := (*requests)[0]
			if got.method != tc.method || got.uri != tc.uri || got.session != "caller-session" {
				t.Fatalf("request = %s %s (session %q), want %s %s from caller-session", got.method, got.uri, got.session, tc.method, tc.uri)
			}
			if !reflect.DeepEqual(got.body, tc.body) {
				t.Fatalf("body = %#v\nwant %#v", got.body, tc.body)
			}
		})
	}
}

func TestWatchToolsRefuseMalformedRequestsWithoutSendingThem(t *testing.T) {
	srv, requests := watchDoor(t, http.StatusOK, activeWatchReply)
	mcp := watchMCP(t, srv.URL, true)
	oneTask := []interface{}{map[string]interface{}{"kind": "TASK", "id": "t1"}}
	cases := []struct {
		tool string
		args map[string]interface{}
		says string
	}{
		{"watch_create", map[string]interface{}{"targets": oneTask}, "predicate is required"},
		{"watch_create", map[string]interface{}{"predicate": map[string]interface{}{"kind": "ALL"}}, "targets is required"},
		{"watch_create", map[string]interface{}{"targets": []interface{}{map[string]interface{}{"id": "t1"}}, "predicate": map[string]interface{}{"kind": "ALL"}}, "targets[0] needs a kind"},
		{"watch_create", map[string]interface{}{"targets": oneTask, "predicate": "ALL TASK_DONE"}, "predicate must be a JSON object"},
		{"task_await", map[string]interface{}{}, "taskIds is required"},
		{"task_await", map[string]interface{}{"taskIds": []interface{}{"t1"}, "until": "someday"}, "until must be one of ALL_TERMINAL_OR_ANY_FAILED"},
		{"task_await", map[string]interface{}{"taskIds": []interface{}{"t1"}, "ttlSeconds": float64(30)}, "ttlSeconds must be a whole number of seconds from 60 to 2592000"},
		{"session_await", map[string]interface{}{"sessionIds": []interface{}{"s1"}, "ttlSeconds": 600.5}, "ttlSeconds must be"},
		{"watch_update", map[string]interface{}{"watchId": "w1"}, "nothing to update"},
		{"watch_get", map[string]interface{}{"watchId": "../sessions"}, "single safe path segment"},
		{"watch_cancel", map[string]interface{}{}, "watchId is required"},
	}
	for _, tc := range cases {
		result := mcp.callTool(tc.tool, tc.args)
		text := watchToolText(t, result)
		if result["isError"] != true || !strings.Contains(text, tc.says) {
			t.Errorf("%s(%v) = %q (isError %v), want a refusal saying %q", tc.tool, tc.args, text, result["isError"], tc.says)
		}
	}
	if len(*requests) != 0 {
		t.Fatalf("a refused request reached the server: %#v", *requests)
	}
}

func TestWatchToolsActOnlyForTheSessionTheyRunIn(t *testing.T) {
	unreachable := NewTransport("http://127.0.0.1:1", "runner-token")
	outside := &mcpServer{t: unreachable, allowOrchestration: true}
	args := map[string]interface{}{"taskIds": []interface{}{"t1"}, "sessionIds": []interface{}{"s1"}, "watchId": "w1"}
	for name := range watchToolNames {
		if result := outside.callTool(name, args); result["isError"] != true {
			t.Errorf("%s ran with no session to act for: %s", name, watchToolText(t, result))
		}
	}
	// session_await watches sessions, so it is refused wherever session_get is.
	gated := &mcpServer{t: unreachable, sessionID: "caller-session"}
	if text := watchToolText(t, gated.callTool("session_await", map[string]interface{}{"sessionIds": []interface{}{"s1"}})); text != orchestrationOffMsg {
		t.Errorf("session_await without orchestration = %q, want %q", text, orchestrationOffMsg)
	}
	if !hasMCPTool(toolDescriptors(false, true), "session_await") || hasMCPTool(toolDescriptors(false, false), "session_await") {
		t.Error("session_await must be offered exactly when orchestration is")
	}
	for _, name := range []string{"watch_create", "watch_get", "watch_list", "watch_update", "watch_cancel", "task_await"} {
		if !hasMCPTool(toolDescriptors(false, false), name) {
			t.Errorf("%s must be offered to every agent, as the task tools are", name)
		}
	}
}

func TestWatchToolsSayPlainlyWhenTheServerHasNoWatchDoor(t *testing.T) {
	missingRoute := `{"message":"Cannot POST /api/runner/watches","error":"Not Found","statusCode":404}`
	srv, _ := watchDoor(t, http.StatusNotFound, missingRoute)
	text := watchToolText(t, watchMCP(t, srv.URL, false).callTool("task_await", map[string]interface{}{"taskIds": []interface{}{"t1"}}))
	for _, phrase := range []string{"no watch door", "Upgrade the Orbit server", "do not fall back to polling"} {
		if !strings.Contains(text, phrase) {
			t.Errorf("an older server's 404 does not say %q: %s", phrase, text)
		}
	}

	missingWatch := `{"message":"watch not found","error":"Not Found","statusCode":404}`
	srv, _ = watchDoor(t, http.StatusNotFound, missingWatch)
	text = watchToolText(t, watchMCP(t, srv.URL, false).callTool("watch_get", map[string]interface{}{"watchId": "w1"}))
	if strings.Contains(text, "no watch door") || !strings.Contains(text, "watch not found") {
		t.Errorf("a watch that is not this session's reads as a missing door: %s", text)
	}
}

func TestWatchResultsSayWhatHappensNext(t *testing.T) {
	matched := `{"id":"w1","state":"MATCHED","action":"RESUME_SESSION","matches":[{"generation":1,` +
		`"matchedAt":"2026-09-14T12:00:00.000Z","reason":"ALL TASK_TERMINAL 2/2"}],` +
		`"targets":[{"targetKind":"TASK","state":"SATISFIED"},{"targetKind":"TASK","state":"SATISFIED"}]}`
	for raw, phrases := range map[string][]string{
		matched: {"already holds (ALL TASK_TERMINAL 2/2)", "end your turn now", `"SATISFIED": 2`},
		`{"id":"w2","state":"ACTIVE","action":"NOTIFY_USER","expiresAt":"2026-09-15T12:00:00.000Z"}`: {"notifies the person", "does not wake this session"},
	} {
		text := describeWatch(json.RawMessage(raw), "create")
		for _, phrase := range phrases {
			if !strings.Contains(text, phrase) {
				t.Errorf("result does not say %q:\n%s", phrase, text)
			}
		}
	}
	if text := describeWatch(json.RawMessage(`{"id":"w3","state":"CANCELLED","action":"RESUME_SESSION"}`), "cancel"); !strings.Contains(text, "nothing will wake this session") {
		t.Errorf("cancel result = %s", text)
	}
}

// The tool text an agent reads when it reaches for the loop it knows has to point at the watch instead.
func TestAgentFacingTextSendsOrbitWaitsToWatches(t *testing.T) {
	descriptors := map[string]map[string]interface{}{}
	for _, tool := range toolDescriptors(false, true) {
		name, _ := tool["name"].(string)
		descriptors[name] = tool
	}
	for tool, await := range map[string]string{
		"task_get":        "task_await",
		"session_get":     "session_await",
		"session_create":  "session_await",
		"schedule_wakeup": "task_await",
	} {
		if description, _ := descriptors[tool]["description"].(string); !strings.Contains(description, await) {
			t.Errorf("%s's description does not point at %s: %q", tool, await, description)
		}
	}
	kind := descriptors["bg_run"]["inputSchema"].(map[string]interface{})["properties"].(map[string]interface{})["kind"].(map[string]interface{})
	if description, _ := kind["description"].(string); !strings.Contains(description, "task_await") {
		t.Errorf("bg_run's kind does not send a wait on Orbit tasks to task_await: %q", description)
	}
	for _, reason := range []string{bgGuardDenyReason, bgGuardScheduleWakeupReason} {
		if !strings.Contains(reason, "mcp__orbit__task_await") {
			t.Errorf("guard refusal does not name mcp__orbit__task_await: %q", reason)
		}
	}
}
