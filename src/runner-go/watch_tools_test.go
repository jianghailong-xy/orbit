package main

import (
	"bytes"
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

// watch_list says of each watch when the server evaluates it next and last did, and how many of its wakes or
// notifications never got there. A count an older server does not send is left out, never shown as none.
func TestWatchListSaysWhenEachWatchIsEvaluatedAndWhatNeverGotThere(t *testing.T) {
	reply := `[` +
		`{"id":"w-waiting","state":"ACTIVE","action":"RESUME_SESSION","expiresAt":"2026-11-02T12:00:00.000Z",` +
		`"createdAt":"2026-11-01T12:00:00.000Z","nextEvaluateAt":"2026-11-01T12:30:00.000Z",` +
		`"lastEvaluatedAt":"2026-11-01T12:00:00.000Z","deadLetterCount":0,"targets":[],"matches":[]},` +
		`{"id":"w-undelivered","state":"MATCHED","action":"RESUME_SESSION","expiresAt":"2026-11-02T11:00:00.000Z",` +
		`"createdAt":"2026-11-01T11:00:00.000Z","nextEvaluateAt":null,"lastEvaluatedAt":"2026-11-01T11:05:00.000Z",` +
		`"deadLetterCount":1,"targets":[],"matches":[{"generation":1,"matchedAt":"2026-11-01T11:05:00.000Z",` +
		`"reason":"ALL TASK_TERMINAL 1/1","deliveries":[{"state":"DEAD_LETTER"}]}]},` +
		`{"id":"w-older-server","state":"ACTIVE","action":"RESUME_SESSION","expiresAt":"2026-11-02T10:00:00.000Z",` +
		`"createdAt":"2026-11-01T10:00:00.000Z","nextEvaluateAt":"2026-11-01T10:01:00.000Z",` +
		`"lastEvaluatedAt":"2026-11-01T10:00:00.000Z","targets":[],"matches":[]}` +
		`]`
	srv, _ := watchDoor(t, http.StatusOK, reply)
	result := watchMCP(t, srv.URL, false).callTool("watch_list", map[string]interface{}{})
	text := watchToolText(t, result)
	if result["isError"] == true {
		t.Fatalf("watch_list failed: %s", text)
	}
	var rows []map[string]interface{}
	if err := json.Unmarshal([]byte(text), &rows); err != nil {
		t.Fatalf("watch_list did not answer with a list: %v\n%s", err, text)
	}
	if len(rows) != 3 {
		t.Fatalf("watch_list shows %d watches, want 3:\n%s", len(rows), text)
	}
	for i, want := range []map[string]interface{}{
		{"watchId": "w-waiting", "nextEvaluateAt": "2026-11-01T12:30:00.000Z", "lastEvaluatedAt": "2026-11-01T12:00:00.000Z", "deadLetterCount": float64(0)},
		{"watchId": "w-undelivered", "nextEvaluateAt": nil, "lastEvaluatedAt": "2026-11-01T11:05:00.000Z", "deadLetterCount": float64(1)},
		{"watchId": "w-older-server", "nextEvaluateAt": "2026-11-01T10:01:00.000Z", "lastEvaluatedAt": "2026-11-01T10:00:00.000Z"},
	} {
		row := rows[i]
		for _, key := range []string{"watchId", "nextEvaluateAt", "lastEvaluatedAt", "deadLetterCount"} {
			got, shown := row[key]
			wanted, expected := want[key]
			if shown != expected || !reflect.DeepEqual(got, wanted) {
				t.Errorf("watch %d shows %s = %#v (shown %v), want %#v (shown %v)", i, key, got, shown, wanted, expected)
			}
		}
	}
	description, _ := watchToolDescriptor(t, "watch_list")["description"].(string)
	for _, field := range []string{"nextEvaluateAt", "lastEvaluatedAt", "deadLetterCount"} {
		if !strings.Contains(description, field) {
			t.Errorf("watch_list's description does not name %s: %q", field, description)
		}
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

// watchToolDescriptor is one tool as the MCP server lists it, orchestration on.
func watchToolDescriptor(t *testing.T, name string) map[string]interface{} {
	t.Helper()
	for _, tool := range toolDescriptors(false, true) {
		if tool["name"] == name {
			return tool
		}
	}
	t.Fatalf("no tool is served as %s", name)
	return nil
}

// The schema an agent reads is the contract's grammar, every version of it: the enum the contract serves,
// each leaf under the version it arrives in, and the bounds a request would be refused against.
func TestWatchToolsOfferEveryPredicateVersionTheContractServes(t *testing.T) {
	contract := watchContract(t)
	served := contract["servedPredicateVersions"]
	if got := asJSON(t, watchPredicateVersions); !reflect.DeepEqual(got, served) {
		t.Fatalf("the tools send predicateVersion %v, the contract serves %v", got, served)
	}
	since := map[string]int{}
	for name, raw := range contract["leaves"].(map[string]interface{}) {
		version := 1
		if n, ok := raw.(map[string]interface{})["sinceVersion"].(float64); ok {
			version = int(n)
		}
		since[name] = version
	}
	if !reflect.DeepEqual(since, watchLeafSinceVersion) {
		t.Errorf("leaf versions here = %v, contract = %v", watchLeafSinceVersion, since)
	}
	limits := contract["limits"].(map[string]interface{})
	if limits["minNoProgressSeconds"] != float64(watchMinNoProgressSeconds) || limits["minNoOutputSeconds"] != float64(watchMinNoOutputSeconds) {
		t.Errorf("the stall minimums here are %d and %d, the contract's are %v and %v", watchMinNoProgressSeconds,
			watchMinNoOutputSeconds, limits["minNoProgressSeconds"], limits["minNoOutputSeconds"])
	}

	for _, name := range []string{"watch_create", "watch_update"} {
		props := watchToolDescriptor(t, name)["inputSchema"].(map[string]interface{})["properties"].(map[string]interface{})
		version := props["predicateVersion"].(map[string]interface{})
		if got := asJSON(t, version["enum"]); !reflect.DeepEqual(got, served) {
			t.Errorf("%s's predicateVersion enum = %v, want the contract's %v", name, got, served)
		}
		if name == "watch_create" {
			description, _ := watchToolDescriptor(t, name)["description"].(string)
			for _, phrase := range []string{"never runs a command", "prints only when what it polls changes", "wakeOnStall"} {
				if !strings.Contains(description, phrase) {
					t.Errorf("watch_create's description does not say %q", phrase)
				}
			}
		}
		grammar, _ := props["predicate"].(map[string]interface{})["description"].(string)
		for leaf := range watchLeafSinceVersion {
			if !strings.Contains(grammar, leaf) {
				t.Errorf("%s's predicate description does not name %s", name, leaf)
			}
		}
		for _, phrase := range []string{
			`"kind":"AT_LEAST","count":N`, `"params"`, `{"seconds":S,"jobId":"bgj_...`, "Version 2", "Version 3",
			"300 at least", "holds even when that runner has died", "SESSION_RUN_TERMINAL", "under ANY_OF",
			// No shell in the grammar, and what to do instead for a system outside Orbit.
			"no shell", "the server runs no command", "prints a line only when the state it polls changes", "wakeOnStall",
		} {
			if !strings.Contains(grammar, phrase) {
				t.Errorf("%s's predicate description does not say %q:\n%s", name, phrase, grammar)
			}
		}
	}
}

// What the tool sends when the agent names no version: the lowest grammar its terms are in, so a version-1
// wait is still a version-1 request any server takes, and a later leaf goes out under the grammar it needs.
func TestWatchCreateSendsTheLowestVersionItsPredicateNeeds(t *testing.T) {
	job := `{"kind":"ANY","over":"ALL_TARGETS","leaf":"SESSION_JOB_NO_OUTPUT_FOR","params":{"seconds":1800,"jobId":"bgj_0a1b2c3d4e5f"}}`
	cases := []struct {
		name      string
		predicate string
		version   interface{}
		want      float64
	}{
		{"a version-1 predicate", `{"kind":"ANY_OF","operands":[{"kind":"ALL","over":"ALL_TARGETS","leaf":"TASK_TERMINAL"},{"kind":"ANY","over":"ALL_TARGETS","leaf":"TASK_FAILED"}]}`, nil, 1},
		{"a task stall", `{"kind":"ANY","over":"ALL_TARGETS","leaf":"TASK_NO_PROGRESS_FOR","params":{"seconds":900}}`, nil, 2},
		{"a progress mark", `{"kind":"ALL","over":"ALL_TARGETS","leaf":"TASK_PROGRESS_AT_LEAST","params":{"percent":50}}`, nil, 2},
		{"a quorum of a version-1 leaf", `{"kind":"AT_LEAST","count":2,"over":"ALL_TARGETS","leaf":"TASK_DONE"}`, nil, 2},
		{"a quiet job", job, nil, 3},
		{"a quiet job beside a run ending", `{"kind":"ANY_OF","operands":[` + job + `,{"kind":"ANY","over":"ALL_TARGETS","leaf":"SESSION_RUN_TERMINAL"}]}`, nil, 3},
		// A leaf this binary does not know goes out under the newest grammar, whose refusal lists every leaf.
		{"an unknown leaf", `{"kind":"ALL","over":"ALL_TARGETS","leaf":"TASK_REOPENED"}`, nil, 3},
		{"an unknown kind", `{"kind":"SHELL","command":"true"}`, nil, 3},
		// A version the agent named is the server's to judge, never rewritten here.
		{"a version the agent named", job, float64(2), 2},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv, requests := watchDoor(t, http.StatusCreated, activeWatchReply)
			mcp := watchMCP(t, srv.URL, true)
			args := map[string]interface{}{
				"targets":   []interface{}{map[string]interface{}{"kind": "SESSION", "id": "s1"}},
				"predicate": tc.predicate,
			}
			if tc.version != nil {
				args["predicateVersion"] = tc.version
			}
			if result := mcp.callTool("watch_create", args); result["isError"] == true {
				t.Fatalf("watch_create failed: %s", watchToolText(t, result))
			}
			update := mcp.callTool("watch_update", map[string]interface{}{"watchId": "w1", "predicate": tc.predicate, "predicateVersion": tc.version})
			if update["isError"] == true {
				t.Fatalf("watch_update failed: %s", watchToolText(t, update))
			}
			if len(*requests) != 2 {
				t.Fatalf("requests = %#v, want a create and an update", *requests)
			}
			for _, request := range *requests {
				if request.body["predicateVersion"] != tc.want {
					t.Errorf("%s %s sent predicateVersion %v, want %v", request.method, request.uri, request.body["predicateVersion"], tc.want)
				}
			}
		})
	}
}

// The contract's own refusals of a term under an earlier grammar are exactly the predicates this tool
// would send under a later one: what the tool infers and what the server serves cannot disagree.
func TestTheInferredVersionIsTheOneTheContractsGrammarNeeds(t *testing.T) {
	checked := 0
	for _, raw := range watchContract(t)["vectors"].([]interface{}) {
		vector := raw.(map[string]interface{})
		given := vector["given"].(map[string]interface{})
		named, ok := given["predicateVersion"].(float64)
		if !ok {
			continue
		}
		predicate := given["predicate"].(map[string]interface{})
		refused := vector["expect"].(map[string]interface{})["refusal"] == "UNKNOWN_PREDICATE_KIND"
		if needs := minimalWatchPredicateVersion(predicate); (needs > int(named)) != refused {
			t.Errorf("%s: the tool would send version %d for a predicate the contract %s under version %v", vector["id"],
				needs, map[bool]string{true: "refuses", false: "accepts"}[refused], named)
		}
		checked++
	}
	if checked < 2 {
		t.Fatalf("only %d vectors name a predicate version: the check reads nothing", checked)
	}
}

// The CLI sends what the tools send: the lowest grammar the predicate needs, or the version it was given.
func TestWatchCLISendsTheLowestVersionItsPredicateNeeds(t *testing.T) {
	job := `{"kind":"ANY","over":"ALL_TARGETS","leaf":"SESSION_JOB_NO_OUTPUT_FOR","params":{"seconds":600}}`
	for _, tc := range []struct {
		args []string
		want float64
	}{
		{[]string{"create", "--target", "SESSION:s1", "--predicate", job, "--json"}, 3},
		{[]string{"create", "--target", "SESSION:s1", "--predicate", job, "--predicate-version", "2", "--json"}, 2},
		{[]string{"update", "w1", "--predicate", `{"kind":"ANY","over":"ALL_TARGETS","leaf":"TASK_NO_PROGRESS_FOR","params":{"seconds":60}}`, "--json"}, 2},
		{[]string{"update", "w1", "--predicate", `{"kind":"ALL","over":"ALL_TARGETS","leaf":"SESSION_TURN_SETTLED"}`, "--json"}, 1},
	} {
		srv, requests := watchDoor(t, http.StatusOK, activeWatchReply)
		configureWatchCLISession(t, srv.URL)
		var out bytes.Buffer
		if err := cmdWatchCLI(tc.args, strings.NewReader(""), &out); err != nil {
			t.Fatalf("%v: %v", tc.args, err)
		}
		if len(*requests) != 1 || (*requests)[0].body["predicateVersion"] != tc.want {
			t.Errorf("%v sent %#v, want predicateVersion %v", tc.args, *requests, tc.want)
		}
	}
}
