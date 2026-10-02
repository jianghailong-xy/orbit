package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// `codeless` — SR5's escape hatch, a task that produces no code — has been a column since 0231 and
// a fact the landing lane reads, and until 0346 no agent could write it: task_create, each
// task_create_batch item and task_update built their bodies from field lists that did not name it,
// and `orbit task create|update` had no flag for it. A rollout task filed without it held its
// criterion off LANDED for ever (2026-10-01). These pin the declaration to the wire at both doors,
// and the reason the edit door asks for beside it.

func TestMCPTaskToolsDeclareCodeless(t *testing.T) {
	tools := toolDescriptors(false, false)
	batch := mcpToolProps(tools, "task_create_batch")
	tasks, _ := batch["tasks"].(map[string]interface{})
	items, _ := tasks["items"].(map[string]interface{})
	itemProps, _ := items["properties"].(map[string]interface{})

	for label, props := range map[string]map[string]interface{}{
		"task_create":            mcpToolProps(tools, "task_create"),
		"task_create_batch item": itemProps,
		"task_update":            mcpToolProps(tools, "task_update"),
	} {
		codeless, ok := props["codeless"].(map[string]interface{})
		if !ok || codeless["type"] != "boolean" {
			t.Fatalf("%s codeless = %#v, want a boolean", label, props["codeless"])
		}
		description, _ := codeless["description"].(string)
		for _, phrase := range []string{"no code", "landing"} {
			if !strings.Contains(description, phrase) {
				t.Errorf("%s codeless description does not say %q: %q", label, phrase, description)
			}
		}
		_, hasReason := props["codelessReason"]
		if hasReason != (label == "task_update") {
			t.Errorf("%s codelessReason declared = %v: a reason is asked only of the edit door", label, hasReason)
		}
	}

	update := mcpToolProps(tools, "task_update")
	reason, _ := update["codelessReason"].(map[string]interface{})
	if reason["type"] != "string" || reason["maxLength"] != 2000 {
		t.Fatalf("task_update codelessReason = %#v", update["codelessReason"])
	}
	codeless, _ := update["codeless"].(map[string]interface{})
	description, _ := codeless["description"].(string)
	for _, phrase := range []string{"codelessReason", "TASK_CODELESS_HAS_COMMITS", "commits of its own", "false"} {
		if !strings.Contains(description, phrase) {
			t.Errorf("task_update codeless description does not state %q: %q", phrase, description)
		}
	}
}

func TestMCPTaskCreateSendsCodeless(t *testing.T) {
	srv, bodies := captureCreateBody(t, "/api/runner/tasks")

	mcp := &mcpServer{agentID: "agent-1", sessionID: "sess-1", t: NewTransport(srv.URL, "tok")}
	res := mcp.callTool("task_create", map[string]interface{}{
		"title":               "Roll it out and walk it through",
		"codeless":            true,
		"completionCriterion": "OWNER_CONFIRMED",
	})
	if res["isError"] == true {
		t.Fatalf("task_create returned an error: %#v", res["content"])
	}
	if len(*bodies) != 1 {
		t.Fatalf("requests = %d", len(*bodies))
	}
	if got := (*bodies)[0]["codeless"]; got != true {
		t.Fatalf("codeless = %#v, body = %#v", got, (*bodies)[0])
	}
}

// The batch copies its items through a second field list, and runs the approval path, where the
// body is built once for the preview a person approves and again for the write.
func TestMCPTaskCreateBatchSendsEachItemsCodeless(t *testing.T) {
	var previewBody, createBody map[string]interface{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/tasks/batch-preview"):
			_ = json.NewDecoder(r.Body).Decode(&previewBody)
			_, _ = w.Write([]byte(`{"taskCount":2,"startingNow":0}`))
		case strings.HasSuffix(r.URL.Path, "/approvals"):
			_, _ = w.Write([]byte(`{"id":"ap1","status":"ALLOWED"}`))
		case strings.Contains(r.URL.Path, "/approvals/"):
			_, _ = w.Write([]byte(`{"status":"ALLOWED"}`))
		default:
			_ = json.NewDecoder(r.Body).Decode(&createBody)
			_, _ = w.Write([]byte(`[{"id":"t1"},{"id":"t2"}]`))
		}
	}))
	defer srv.Close()

	mcp := &mcpServer{agentID: "agent-1", sessionID: "sess-1", t: NewTransport(srv.URL, "tok")}
	res := mcp.callTool("task_create_batch", map[string]interface{}{
		"tasks": []interface{}{
			map[string]interface{}{"title": "build it", "completionCriterion": "EVIDENCE_JUDGMENT"},
			map[string]interface{}{"title": "roll it out", "codeless": true, "completionCriterion": "OWNER_CONFIRMED"},
		},
	})
	if res["isError"] == true {
		t.Fatalf("task_create_batch returned an error: %#v", res["content"])
	}
	for label, body := range map[string]map[string]interface{}{"preview": previewBody, "create": createBody} {
		sent, _ := body["tasks"].([]interface{})
		if len(sent) != 2 {
			t.Fatalf("%s body = %#v, want two tasks", label, body)
		}
		code, _ := sent[0].(map[string]interface{})
		if _, present := code["codeless"]; present {
			t.Fatalf("%s tasks[0] was declared codeless without saying so: %#v", label, code)
		}
		rollout, _ := sent[1].(map[string]interface{})
		if rollout["codeless"] != true {
			t.Fatalf("%s tasks[1] codeless = %#v", label, rollout["codeless"])
		}
	}
}

func TestMCPTaskUpdateSendsCodelessAndItsReason(t *testing.T) {
	for _, tc := range []struct {
		name string
		args map[string]interface{}
		want map[string]interface{}
	}{
		{
			name: "declared, with the reason",
			args: map[string]interface{}{"taskId": "t1", "codeless": true, "codelessReason": "it deploys; it commits nothing"},
			want: map[string]interface{}{"codeless": true, "codelessReason": "it deploys; it commits nothing"},
		},
		{
			name: "taken back",
			args: map[string]interface{}{"taskId": "t1", "codeless": false},
			want: map[string]interface{}{"codeless": false},
		},
		{
			name: "omitted is left alone",
			args: map[string]interface{}{"taskId": "t1", "title": "Renamed"},
			want: map[string]interface{}{},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv, raws := captureUpdateRawBody(t)
			mcp := &mcpServer{agentID: "agent-1", t: NewTransport(srv.URL, "tok")}
			res := mcp.callTool("task_update", tc.args)
			if res["isError"] == true {
				t.Fatalf("task_update returned an error: %#v", res["content"])
			}
			if len(*raws) != 1 {
				t.Fatalf("requests = %d", len(*raws))
			}
			var body map[string]interface{}
			if err := json.Unmarshal((*raws)[0], &body); err != nil {
				t.Fatal(err)
			}
			for _, field := range []string{"codeless", "codelessReason"} {
				want, wanted := tc.want[field]
				got, present := body[field]
				if present != wanted || got != want {
					t.Fatalf("%s = %#v (present %v), want %#v (present %v): %s",
						field, got, present, want, wanted, (*raws)[0])
				}
			}
		})
	}
}

func TestCLITaskCreateSendsCodeless(t *testing.T) {
	for _, tc := range []struct {
		name    string
		flags   []string
		present bool
		want    bool
	}{
		{name: "--codeless declares it", flags: []string{"--codeless"}, present: true, want: true},
		{name: "--codeless=false says the default", flags: []string{"--codeless=false"}, present: true, want: false},
		{name: "no flag sends nothing", flags: nil, present: false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv, bodies := captureCreateBody(t, "/api/runner/tasks")
			configureCLITestRunner(t, srv.URL)
			t.Setenv("ORBIT_SESSION_ID", "")

			args := append([]string{"create", "--title", "Roll it out",
				"--completion-criterion", "OWNER_CONFIRMED", "--json"}, tc.flags...)
			var out bytes.Buffer
			if err := cmdTaskCLI(args, strings.NewReader(""), &out); err != nil {
				t.Fatal(err)
			}
			if len(*bodies) != 1 {
				t.Fatalf("requests = %d", len(*bodies))
			}
			got, present := (*bodies)[0]["codeless"]
			if present != tc.present || (present && got != tc.want) {
				t.Fatalf("codeless = %#v (present %v), body = %#v", got, present, (*bodies)[0])
			}
		})
	}
}

func TestCLITaskUpdateSendsCodelessWithItsReason(t *testing.T) {
	for _, tc := range []struct {
		name string
		args []string
		want map[string]interface{}
	}{
		{
			name: "--codeless with --codeless-reason",
			args: []string{"update", "task-1", "--codeless", "--codeless-reason", "  it deploys; it commits nothing  ", "--json"},
			want: map[string]interface{}{"codeless": true, "codelessReason": "it deploys; it commits nothing"},
		},
		{
			name: "--codeless=false takes it back",
			args: []string{"update", "task-1", "--codeless=false", "--json"},
			want: map[string]interface{}{"codeless": false},
		},
		{
			name: "neither flag leaves it alone",
			args: []string{"update", "task-1", "--title", "Renamed", "--json"},
			want: map[string]interface{}{},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv, raws := captureUpdateRawBody(t)
			configureCLITestRunner(t, srv.URL)
			t.Setenv("ORBIT_SESSION_ID", "")

			var out bytes.Buffer
			if err := cmdTaskCLI(tc.args, strings.NewReader(""), &out); err != nil {
				t.Fatal(err)
			}
			if len(*raws) != 1 {
				t.Fatalf("requests = %d", len(*raws))
			}
			var body map[string]interface{}
			if err := json.Unmarshal((*raws)[0], &body); err != nil {
				t.Fatal(err)
			}
			for _, field := range []string{"codeless", "codelessReason"} {
				want, wanted := tc.want[field]
				got, present := body[field]
				if present != wanted || got != want {
					t.Fatalf("%s = %#v (present %v), want %#v (present %v): %s",
						field, got, present, want, wanted, (*raws)[0])
				}
			}
		})
	}
}

// A reason with no declaration explains nothing, and a blank one is an unset shell variable: both
// are refused at the terminal, before any request — whether a reason is REQUIRED is the server's to
// say, since only it knows whether the call changes anything.
func TestCLITaskUpdateCodelessReasonRefusedBeforeTheRoundTrip(t *testing.T) {
	var requests int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests++
		_, _ = w.Write([]byte(`{"id":"task-1"}`))
	}))
	defer srv.Close()
	configureCLITestRunner(t, srv.URL)
	t.Setenv("ORBIT_SESSION_ID", "")

	for _, tc := range []struct {
		args []string
		want string
	}{
		{args: []string{"update", "task-1", "--codeless-reason", "it deploys"}, want: "pass them together"},
		{args: []string{"update", "task-1", "--codeless", "--codeless-reason", "   "}, want: "cannot be blank"},
	} {
		var out bytes.Buffer
		err := cmdTaskCLI(tc.args, strings.NewReader(""), &out)
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Fatalf("%v: err = %v, want it to say %q", tc.args, err, tc.want)
		}
	}
	if requests != 0 {
		t.Fatalf("requests = %d: a refusal at the terminal sent something anyway", requests)
	}
}
