package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

const modelHintReason = "  跨模块修复：\"并发\"\n保留原文  "

type modelHintRequest struct {
	path string
	body map[string]interface{}
}

func captureModelHintRequests(t *testing.T) (*httptest.Server, *[]modelHintRequest) {
	t.Helper()
	var requests []modelHintRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		if strings.Contains(r.URL.Path, "/approvals") {
			_, _ = w.Write([]byte(`{"id":"ap1","status":"ALLOWED"}`))
			return
		}
		var body map[string]interface{}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode %s: %v", r.URL.Path, err)
		}
		requests = append(requests, modelHintRequest{r.URL.Path, body})
		switch r.URL.Path {
		case "/api/runner/tasks/batch-preview":
			_, _ = w.Write([]byte(`{"taskCount":2,"startingNow":0}`))
		case "/api/runner/tasks/batch-create":
			_, _ = w.Write([]byte(`[{"id":"t1"},{"id":"t2"}]`))
		case "/api/runner/tasks", "/api/runner/tasks/t1":
			_, _ = w.Write([]byte(`{"id":"t1"}`))
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
	}))
	t.Cleanup(srv.Close)
	return srv, &requests
}

func assertModelHintFields(t *testing.T, body, want map[string]interface{}) {
	t.Helper()
	for _, key := range []string{"modelHint", "modelHintReason"} {
		got, present := body[key]
		expected, expectedPresent := want[key]
		if present != expectedPresent || !reflect.DeepEqual(got, expected) {
			t.Fatalf("%s = %#v (present %v), want %#v (present %v); body = %#v", key, got, present, expected, expectedPresent, body)
		}
	}
}

func TestTaskModelHintMCPForwarding(t *testing.T) {
	cases := []map[string]interface{}{
		{"modelHint": "S", "modelHintReason": modelHintReason},
		{"modelHint": "M", "modelHintReason": modelHintReason},
		{"modelHint": "L", "modelHintReason": modelHintReason},
		{"modelHint": "XL", "modelHintReason": modelHintReason},
		{"modelHint": nil, "modelHintReason": nil},
		{},
		{"modelHint": "M"},
		{"modelHintReason": nil},
		{"modelHintReason": ""},
	}
	for _, tool := range []string{"task_create", "task_create_batch", "task_update"} {
		for _, fields := range cases {
			t.Run(tool+"/"+mustJSON(t, fields), func(t *testing.T) {
				srv, requests := captureModelHintRequests(t)
				item := map[string]interface{}{"title": "suggested work", "completionCriterion": "EVIDENCE_JUDGMENT", "provider": "codex", "model": "pinned-model"}
				for k, v := range fields {
					item[k] = v
				}
				args := item
				if tool == "task_create_batch" {
					args = map[string]interface{}{"tasks": []interface{}{item, map[string]interface{}{"title": "unsuggested", "completionCriterion": "EVIDENCE_JUDGMENT"}}}
				} else if tool == "task_update" {
					args["taskId"] = "t1"
				}
				mcp := &mcpServer{agentID: "agent-1", sessionID: "session-1", t: NewTransport(srv.URL, "tok")}
				if res := mcp.callTool(tool, args); res["isError"] == true {
					t.Fatalf("%s: %#v", tool, res["content"])
				}
				wantRequests := 1
				if tool == "task_create_batch" {
					wantRequests = 2 // Both the approval preview and the eventual write.
				}
				if len(*requests) != wantRequests {
					t.Fatalf("requests = %#v, want %d", *requests, wantRequests)
				}
				for _, request := range *requests {
					body := request.body
					if tool == "task_create_batch" {
						items := body["tasks"].([]interface{})
						body = items[0].(map[string]interface{})
						assertModelHintFields(t, items[1].(map[string]interface{}), map[string]interface{}{})
					}
					assertModelHintFields(t, body, fields)
					if body["provider"] != "codex" || body["model"] != "pinned-model" {
						t.Fatalf("suggestion changed the engine/model pin: %#v", body)
					}
				}
			})
		}
	}
}

func TestTaskModelHintCLIForwarding(t *testing.T) {
	cases := []struct {
		name  string
		flags []string
		want  map[string]interface{}
	}{
		{"omitted", nil, map[string]interface{}{}},
		{"clear", []string{"--clear-model-hint"}, map[string]interface{}{"modelHint": nil, "modelHintReason": nil}},
		{"empty reason", []string{"--model-hint-reason", ""}, map[string]interface{}{"modelHintReason": ""}},
	}
	for _, hint := range []string{"S", "M", "L", "XL"} {
		cases = append(cases, struct {
			name  string
			flags []string
			want  map[string]interface{}
		}{hint, []string{"--model-hint", hint, "--model-hint-reason", modelHintReason}, map[string]interface{}{"modelHint": hint, "modelHintReason": modelHintReason}})
	}
	for _, action := range []string{"create", "update"} {
		for _, tc := range cases {
			t.Run(action+"/"+tc.name, func(t *testing.T) {
				srv, requests := captureModelHintRequests(t)
				configureCLITestRunner(t, srv.URL)
				t.Setenv("ORBIT_SESSION_ID", "session-1")
				args := []string{action}
				if action == "update" {
					args = append(args, "t1")
				} else {
					args = append(args, "--completion-criterion", "EVIDENCE_JUDGMENT")
				}
				args = append(args, "--title", "suggested work", "--provider", "codex", "--model", "pinned-model", "--json")
				args = append(args, tc.flags...)
				var out bytes.Buffer
				if err := cmdTaskCLI(args, strings.NewReader(""), &out); err != nil {
					t.Fatal(err)
				}
				if len(*requests) != 1 {
					t.Fatalf("requests = %#v", *requests)
				}
				body := (*requests)[0].body
				assertModelHintFields(t, body, tc.want)
				if body["provider"] != "codex" || body["model"] != "pinned-model" {
					t.Fatalf("suggestion changed the engine/model pin: %#v", body)
				}
			})
		}
	}
}

func TestTaskModelHintCLIBatchForwarding(t *testing.T) {
	srv, requests := captureModelHintRequests(t)
	configureCLITestRunner(t, srv.URL)
	t.Setenv("ORBIT_SESSION_ID", "session-1")
	items := []map[string]interface{}{}
	for _, hint := range []interface{}{"S", "M", "L", "XL", nil} {
		reason := interface{}(modelHintReason)
		if hint == nil {
			reason = nil
		}
		items = append(items, map[string]interface{}{"title": "work", "completionCriterion": "EVIDENCE_JUDGMENT", "modelHint": hint, "modelHintReason": reason})
	}
	items = append(items, map[string]interface{}{"title": "unsuggested", "completionCriterion": "EVIDENCE_JUDGMENT"})
	var out bytes.Buffer
	if err := cmdTaskCLI([]string{"create-batch", "--tasks-file", "-", "--json"}, strings.NewReader(mustJSON(t, items)), &out); err != nil {
		t.Fatal(err)
	}
	if len(*requests) != 2 {
		t.Fatalf("preview and write requests = %#v", *requests)
	}
	for _, request := range *requests {
		sent := request.body["tasks"].([]interface{})
		if len(sent) != len(items) {
			t.Fatalf("%s items = %#v", request.path, sent)
		}
		for i, item := range sent {
			assertModelHintFields(t, item.(map[string]interface{}), items[i])
		}
	}
}

func TestTaskModelHintCLIRejectsInvalidOrConflictingFlags(t *testing.T) {
	for _, action := range []string{"create", "update"} {
		for _, flags := range [][]string{
			{"--model-hint", "XXL"}, {"--model-hint", ""},
			{"--clear-model-hint", "--model-hint", "M"},
			{"--clear-model-hint", "--model-hint-reason", "why"},
		} {
			args := []string{action, "--title", "work"}
			if action == "update" {
				args = []string{action, "t1"}
			}
			if err := cmdTaskCLI(append(args, flags...), strings.NewReader(""), &bytes.Buffer{}); err == nil || !strings.Contains(err.Error(), "model-hint") {
				t.Fatalf("%s %v: error = %v", action, flags, err)
			}
		}
	}
}

func TestTaskModelHintSchema(t *testing.T) {
	tools := toolDescriptors(false, false)
	batch := mcpToolProps(tools, "task_create_batch")["tasks"].(map[string]interface{})["items"].(map[string]interface{})["properties"].(map[string]interface{})
	for _, props := range []map[string]interface{}{mcpToolProps(tools, "task_create"), batch, mcpToolProps(tools, "task_update")} {
		hint := props["modelHint"].(map[string]interface{})
		if !reflect.DeepEqual(hint["enum"], []interface{}{"S", "M", "L", "XL", nil}) || !reflect.DeepEqual(hint["type"], []string{"string", "null"}) {
			t.Fatalf("tier schema = %#v", hint)
		}
		for _, phrase := range []string{"Sonnet · low", "Sonnet · medium", "Opus · high", "Opus · max", "low/medium/high/xhigh", "hard pin", "provider"} {
			if !strings.Contains(hint["description"].(string), phrase) || !strings.Contains(taskActionHelp["create"], phrase) || !strings.Contains(taskActionHelp["update"], phrase) {
				t.Errorf("schema or CLI help omits %q", phrase)
			}
		}
		reason := props["modelHintReason"].(map[string]interface{})
		if reason["maxLength"] != 500 || !reflect.DeepEqual(reason["type"], []string{"string", "null"}) {
			t.Fatalf("reason schema = %#v", reason)
		}
	}
}
