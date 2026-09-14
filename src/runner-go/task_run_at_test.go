package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The server has had scheduled starts all along — `task.run_at`, CreateTaskDto.runAt and
// UpdateTaskDto.runAt, and a once-a-minute sweep that starts a task whose time has come. What no
// agent could do was set one: task_create, each task_create_batch item and task_update build their
// bodies from field lists that did not name runAt, and `orbit task create|update` had no flag for it.
// A coordinator that needed a task started next Monday could only arrange to be woken next Monday.
//
// These pin the field to the wire at both doors. The update is three-state like dueDate — absent
// keeps the schedule, null cancels it, an instant (re)schedules — and the null is asserted on the
// request bytes, because a cancel flattened into an omission reports success and cancels nothing.

const (
	runAtFirst = "2026-09-21T12:34:00Z"
	runAtMoved = "2026-09-28T08:00:00Z"
)

func TestMCPTaskCreateSendsRunAt(t *testing.T) {
	srv, bodies := captureCreateBody(t, "/api/runner/tasks")

	mcp := &mcpServer{agentID: "agent-1", sessionID: "sess-1", t: NewTransport(srv.URL, "tok")}
	res := mcp.callTool("task_create", map[string]interface{}{
		"title":               "Recheck criterion 6",
		"runAt":               runAtFirst,
		"completionCriterion": "EVIDENCE_JUDGMENT",
	})
	if res["isError"] == true {
		t.Fatalf("task_create returned an error: %#v", res["content"])
	}
	if len(*bodies) != 1 {
		t.Fatalf("requests = %d", len(*bodies))
	}
	if got := (*bodies)[0]["runAt"]; got != runAtFirst {
		t.Fatalf("runAt = %#v, body = %#v", got, (*bodies)[0])
	}
}

// The batch copies its items through a second field list, and it runs the approval path, where the
// body is built once for the preview a person approves and again for the write.
func TestMCPTaskCreateBatchSendsEachItemsRunAt(t *testing.T) {
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
			map[string]interface{}{"title": "scheduled", "runAt": runAtFirst, "completionCriterion": "EVIDENCE_JUDGMENT"},
			map[string]interface{}{"title": "unscheduled", "completionCriterion": "EVIDENCE_JUDGMENT"},
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
		scheduled, _ := sent[0].(map[string]interface{})
		if scheduled["runAt"] != runAtFirst {
			t.Fatalf("%s tasks[0] runAt = %#v", label, scheduled["runAt"])
		}
		// Per item: one item's schedule is not the batch's.
		unscheduled, _ := sent[1].(map[string]interface{})
		if _, present := unscheduled["runAt"]; present {
			t.Fatalf("%s tasks[1] was given a schedule it never named: %#v", label, unscheduled)
		}
	}
}

func TestMCPTaskUpdateSendsRunAtOmittedNullAndInstant(t *testing.T) {
	for _, tc := range []struct {
		name    string
		args    map[string]interface{}
		present bool
		want    string
	}{
		{
			name:    "omitted keeps the schedule",
			args:    map[string]interface{}{"taskId": "t1", "title": "Renamed"},
			present: false,
		},
		{
			name:    "null cancels it",
			args:    map[string]interface{}{"taskId": "t1", "runAt": nil},
			present: true,
			want:    `"runAt":null`,
		},
		{
			name:    "an instant moves it",
			args:    map[string]interface{}{"taskId": "t1", "runAt": runAtMoved},
			present: true,
			want:    `"runAt":"` + runAtMoved + `"`,
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
			raw := (*raws)[0]
			var body map[string]interface{}
			if err := json.Unmarshal(raw, &body); err != nil {
				t.Fatal(err)
			}
			if _, present := body["runAt"]; present != tc.present {
				t.Fatalf("runAt present = %v, want %v: %s", present, tc.present, raw)
			}
			if tc.present && !strings.Contains(string(raw), tc.want) {
				t.Fatalf("body = %s, want it to contain %s", raw, tc.want)
			}
		})
	}
}

// A model reads the schema before it writes anything. runAt has to be declared on both create doors
// as a string and nullable on the update door, where "cancel the schedule" has to be sayable. And the
// description has to say what the field is: the name alone reads like a deadline, and the rules a due
// schedule still has to meet are not something a caller can learn from the success of the write.
func TestMCPTaskToolsDeclareRunAtAsAOneShotScheduledStart(t *testing.T) {
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
		runAt, ok := props["runAt"].(map[string]interface{})
		if !ok {
			t.Fatalf("%s declares no runAt: %#v", label, props["runAt"])
		}
		if label == "task_update" {
			types, _ := runAt["type"].([]string)
			if len(types) != 2 || types[0] != "string" || types[1] != "null" {
				t.Fatalf("task_update runAt type = %#v, want [string null]", runAt["type"])
			}
		} else if runAt["type"] != "string" {
			t.Fatalf("%s runAt type = %#v, want string", label, runAt["type"])
		}

		description, _ := runAt["description"].(string)
		for _, phrase := range []string{
			// what it is, and what it is not
			"one-time", "dueDate",
			// who starts it, and that the other automatic trigger has nothing to do with it
			"once a minute", "autoRunWhenReady",
			// spent by the run it starts
			"clears runAt",
			// what a due schedule still has to meet
			"OPEN", "dispatchHold", "assignee bound to a runner", "prerequisite", "occupying",
			// a time already gone, and the immediate door
			"already past", "task_start",
		} {
			if !strings.Contains(description, phrase) {
				t.Errorf("%s runAt description does not state %q: %q", label, phrase, description)
			}
		}
		if label == "task_update" && !strings.Contains(description, "null") {
			t.Errorf("task_update runAt description does not say what null does: %q", description)
		}
	}
}

func TestTaskCLICreateSendsRunAt(t *testing.T) {
	srv, bodies := captureCreateBody(t, "/api/runner/tasks")
	configureCLITestRunner(t, srv.URL)
	t.Setenv("ORBIT_SESSION_ID", "")

	var out bytes.Buffer
	if err := cmdTaskCLI([]string{
		"create", "--title", "Recheck criterion 6", "--completion-criterion", "EVIDENCE_JUDGMENT",
		"--run-at", runAtFirst, "--json",
	}, strings.NewReader(""), &out); err != nil {
		t.Fatal(err)
	}
	if len(*bodies) != 1 {
		t.Fatalf("requests = %d", len(*bodies))
	}
	if got := (*bodies)[0]["runAt"]; got != runAtFirst {
		t.Fatalf("runAt = %#v, body = %#v", got, (*bodies)[0])
	}
}

func TestTaskCLIUpdateSendsRunAtClearsItAndOtherwiseLeavesItAlone(t *testing.T) {
	for _, tc := range []struct {
		name    string
		args    []string
		present bool
		want    string
	}{
		{
			name:    "--run-at moves it",
			args:    []string{"update", "task-1", "--run-at", runAtMoved, "--json"},
			present: true,
			want:    `"runAt":"` + runAtMoved + `"`,
		},
		{
			name:    "--clear-run-at cancels it",
			args:    []string{"update", "task-1", "--clear-run-at", "--json"},
			present: true,
			want:    `"runAt":null`,
		},
		{
			name:    "neither flag leaves it alone",
			args:    []string{"update", "task-1", "--title", "Renamed", "--json"},
			present: false,
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
			raw := (*raws)[0]
			var body map[string]interface{}
			if err := json.Unmarshal(raw, &body); err != nil {
				t.Fatal(err)
			}
			if _, present := body["runAt"]; present != tc.present {
				t.Fatalf("runAt present = %v, want %v: %s", present, tc.present, raw)
			}
			if tc.present && !strings.Contains(string(raw), tc.want) {
				t.Fatalf("body = %s, want it to contain %s", raw, tc.want)
			}
		})
	}
}

// Opposite instructions about one field, and a blank value that is a typo or an unset shell
// variable, are caught before any request — the treatment --clear-due-date/--due-date already get.
func TestTaskCLIRunAtRefusesContradictionsAndBlanksBeforeTheRoundTrip(t *testing.T) {
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
		{[]string{"update", "task-1", "--run-at", runAtMoved, "--clear-run-at", "--json"}, "--clear-run-at and --run-at cannot be used together"},
		{[]string{"update", "task-1", "--run-at", "", "--json"}, "--run-at cannot be empty; use --clear-run-at"},
		{[]string{"create", "--title", "Ship it", "--completion-criterion", "EVIDENCE_JUDGMENT", "--run-at", " ", "--json"}, "--run-at cannot be empty"},
	} {
		var out bytes.Buffer
		err := cmdTaskCLI(tc.args, strings.NewReader(""), &out)
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Fatalf("%v: err = %v, want %q", tc.args, err, tc.want)
		}
	}
	if requests != 0 {
		t.Fatalf("requests = %d, want every one caught before the round trip", requests)
	}
}

// `orbit task create-batch` forwards each item as written, so an item's runAt needs no flag of its
// own; pinned so that a per-field copy of the items cannot start dropping it.
func TestTaskCLICreateBatchSendsEachItemsRunAt(t *testing.T) {
	var body map[string]interface{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/runner/tasks/batch-create" {
			t.Errorf("request = %s %s", r.Method, r.URL.Path)
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode body: %v", err)
		}
		_, _ = w.Write([]byte(`[{"id":"t1"},{"id":"t2"}]`))
	}))
	defer srv.Close()
	configureCLITestRunner(t, srv.URL)
	t.Setenv("ORBIT_SESSION_ID", "")

	stdin := strings.NewReader(`[{"title":"scheduled","runAt":"` + runAtFirst + `","completionCriterion":"EVIDENCE_JUDGMENT"},
	  {"title":"unscheduled","completionCriterion":"EVIDENCE_JUDGMENT"}]`)
	var out bytes.Buffer
	if err := cmdTaskCLI([]string{"create-batch", "--tasks-file", "-", "--json"}, stdin, &out); err != nil {
		t.Fatal(err)
	}
	sent, _ := body["tasks"].([]interface{})
	if len(sent) != 2 {
		t.Fatalf("body = %#v, want two tasks", body)
	}
	if scheduled, _ := sent[0].(map[string]interface{}); scheduled["runAt"] != runAtFirst {
		t.Fatalf("tasks[0] runAt = %#v", scheduled["runAt"])
	}
	if unscheduled, _ := sent[1].(map[string]interface{}); unscheduled["runAt"] != nil {
		t.Fatalf("tasks[1] was given a schedule it never named: %#v", unscheduled)
	}
}

// `orbit capabilities` is how an agent finds the CLI door and --help is how a person does. The
// parity tests check that every MCP parameter is named and every advertised flag is in the help;
// this pins what both have to say about the schedule, the batch included, which has no flag for it.
func TestTaskRunAtIsAdvertisedInCapabilitiesAndHelp(t *testing.T) {
	specs := map[string]cliCapabilitySpec{}
	for _, spec := range baseCLICapabilities {
		specs[spec.Tool] = spec
	}
	for tool, flags := range map[string][]string{
		"task_create": {"--run-at"},
		"task_update": {"--run-at", "--clear-run-at"},
	} {
		arguments := strings.Join(specs[tool].Arguments, " ")
		for _, flag := range flags {
			if !strings.Contains(arguments, flag) {
				t.Errorf("%s capability arguments do not name %s: %v", tool, flag, specs[tool].Arguments)
			}
		}
	}
	for action, flags := range map[string][]string{
		"create": {"--run-at"},
		"update": {"--run-at", "--clear-run-at"},
	} {
		for _, flag := range flags {
			if !strings.Contains(taskActionHelp[action], flag) {
				t.Errorf("`orbit task %s --help` does not document %s", action, flag)
			}
		}
	}
	if !strings.Contains(taskActionHelp["create-batch"], "runAt") {
		t.Errorf("`orbit task create-batch --help` does not list runAt among the item fields")
	}
	if !strings.Contains(specs["task_create_batch"].Description, "runAt") {
		t.Errorf("task_create_batch capability description does not mention runAt: %q",
			specs["task_create_batch"].Description)
	}
}
