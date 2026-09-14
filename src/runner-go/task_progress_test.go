package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"reflect"
	"sort"
	"strings"
	"testing"
)

const progressedReply = `{"taskId":"task-current","lifecycleEpoch":0,"epochStartedAt":"2026-09-14T10:00:00.000Z",` +
	`"phase":"tests","current":3,"total":8,"message":null,"revision":4,` +
	`"lastProgressAt":"2026-09-14T12:00:00.000Z","updatedAt":"2026-09-14T12:00:00.000Z","changed":true,"progressed":true}`

const progressViewReply = `{"taskId":"t9","lifecycleEpoch":1,"epochStartedAt":"2026-09-14T10:00:00.000Z",` +
	`"phase":null,"current":null,"total":null,"message":null,"revision":2,"lastProgressAt":null,"updatedAt":null}`

// progressMCP is the MCP server of a session running task-current, talking to serverURL.
func progressMCP(t *testing.T, serverURL string) *mcpServer {
	t.Helper()
	t.Setenv("ORBIT_HOME", t.TempDir())
	return &mcpServer{t: NewTransport(serverURL, "runner-token"), taskID: "task-current"}
}

func configureProgressCLI(t *testing.T, serverURL string) {
	t.Helper()
	configureCLITestRunner(t, serverURL)
	t.Setenv("ORBIT_TASK_ID", "task-env")
	t.Setenv("ORBIT_SESSION_ID", "")
	t.Setenv("ORBIT_AGENT_ID", "")
	t.Setenv("ORBIT_SERVICE_TOKEN", "")
}

func TestTaskProgressReportSendsExactlyTheFieldsNamed(t *testing.T) {
	srv, requests := watchDoor(t, http.StatusOK, progressedReply)
	result := progressMCP(t, srv.URL).callTool("task_progress_report", map[string]interface{}{
		"phase":            "tests",
		"current":          float64(3),
		"total":            nil,
		"expectedRevision": "3",
	})
	text := watchToolText(t, result)
	if result["isError"] == true {
		t.Fatalf("task_progress_report failed: %s", text)
	}
	if len(*requests) != 1 {
		t.Fatalf("requests = %#v, want one report", *requests)
	}
	got := (*requests)[0]
	if got.method != http.MethodPost || got.uri != "/api/runner/tasks/task-current/progress" {
		t.Fatalf("request = %s %s, want a POST to the current task's progress", got.method, got.uri)
	}
	// message was not named, so it is not sent and the server keeps it; total was named as null, so it is cleared.
	want := map[string]interface{}{"phase": "tests", "current": float64(3), "total": nil, "expectedRevision": float64(3)}
	if !reflect.DeepEqual(got.body, want) {
		t.Fatalf("body = %#v\nwant %#v", got.body, want)
	}
	if !strings.Contains(text, "Recorded as progress at revision 4") {
		t.Errorf("result does not say what was recorded:\n%s", text)
	}
}

func TestTaskProgressReportWithNothingToReportReadsTheProgress(t *testing.T) {
	for name, args := range map[string]map[string]interface{}{
		"only a task":              {"taskId": "t9"},
		"a null expected revision": {"taskId": "t9", "expectedRevision": nil},
	} {
		t.Run(name, func(t *testing.T) {
			srv, requests := watchDoor(t, http.StatusOK, progressViewReply)
			result := progressMCP(t, srv.URL).callTool("task_progress_report", args)
			text := watchToolText(t, result)
			if result["isError"] == true {
				t.Fatalf("task_progress_report failed: %s", text)
			}
			if len(*requests) != 1 {
				t.Fatalf("requests = %#v, want one read", *requests)
			}
			if got := (*requests)[0]; got.method != http.MethodGet || got.uri != "/api/runner/tasks/t9/progress" || got.body != nil {
				t.Fatalf("request = %#v, want a GET of t9's progress with no body", got)
			}
			if !strings.Contains(text, "is at revision 2, epoch 1") || !strings.Contains(text, "pass expectedRevision 2") {
				t.Errorf("a read does not name the revision to report against:\n%s", text)
			}
		})
	}
}

func TestTaskProgressResultsSayWhetherTheReportWasProgress(t *testing.T) {
	for raw, phrases := range map[string][]string{
		`{"taskId":"t1","revision":5,"lastProgressAt":"2026-09-14T12:00:00.000Z","changed":true,"progressed":false}`: {
			"not as progress", "only a change of phase, current or total is progress", "stays 2026-09-14T12:00:00.000Z",
		},
		`{"taskId":"t1","revision":5,"lastProgressAt":"2026-09-14T12:00:00.000Z","changed":false,"progressed":false}`: {
			"Nothing changed", "nothing was written", "not progress",
		},
	} {
		text := describeTaskProgress(json.RawMessage(raw))
		for _, phrase := range phrases {
			if !strings.Contains(text, phrase) {
				t.Errorf("result does not say %q:\n%s", phrase, text)
			}
		}
	}
}

func TestTaskProgressReportRefusesMalformedArgumentsWithoutSending(t *testing.T) {
	srv, requests := watchDoor(t, http.StatusOK, progressedReply)
	mcp := progressMCP(t, srv.URL)
	cases := []struct {
		args map[string]interface{}
		says string
	}{
		{map[string]interface{}{"current": "three"}, "current must be a whole number"},
		{map[string]interface{}{"total": 2.5}, "total must be a whole number"},
		{map[string]interface{}{"phase": float64(7)}, "phase must be a string"},
		{map[string]interface{}{"message": true}, "message must be a string"},
		{map[string]interface{}{"expectedRevision": float64(2)}, "expectedRevision guards a report"},
		{map[string]interface{}{"current": float64(1), "expectedRevision": "latest"}, "expectedRevision must be the whole-number revision"},
		{map[string]interface{}{"taskId": "../sessions", "current": float64(1)}, "single safe path segment"},
	}
	for _, tc := range cases {
		result := mcp.callTool("task_progress_report", tc.args)
		if text := watchToolText(t, result); result["isError"] != true || !strings.Contains(text, tc.says) {
			t.Errorf("task_progress_report(%v) = %q (isError %v), want a refusal saying %q", tc.args, text, result["isError"], tc.says)
		}
	}
	outside := &mcpServer{t: NewTransport(srv.URL, "runner-token")}
	if text := watchToolText(t, outside.callTool("task_progress_report", map[string]interface{}{"current": float64(1)})); text != noTaskMsg {
		t.Errorf("a report with no task to name = %q, want %q", text, noTaskMsg)
	}
	if len(*requests) != 0 {
		t.Fatalf("a refused report reached the server: %#v", *requests)
	}
}

func TestTaskProgressRefusalsSayWhatToDoNext(t *testing.T) {
	cases := []struct {
		name    string
		status  int
		reply   string
		says    []string
		notSays string
	}{
		{
			name:   "a moved revision",
			status: http.StatusConflict,
			reply: `{"code":"PROGRESS_REVISION_CONFLICT","revision":5,"lifecycleEpoch":0,` +
				`"message":"the report expected revision 4 and the progress is at revision 5: read it again before reporting"}`,
			says: []string{"PROGRESS_REVISION_CONFLICT", "read it again (task_progress_report with only taskId), then report against the revision it shows"},
		},
		{
			name:   "a task with a conclusion",
			status: http.StatusConflict,
			reply: `{"code":"TASK_NOT_OPEN","status":"FAILED",` +
				`"message":"a FAILED task makes no progress: reopening it starts a new lifecycle epoch to report into"}`,
			says:    []string{"TASK_NOT_OPEN", "reopening it starts a new lifecycle epoch"},
			notSays: "read it again (",
		},
		{
			name:   "a server without the door",
			status: http.StatusNotFound,
			reply:  `{"message":"Cannot POST /api/runner/tasks/task-current/progress","error":"Not Found","statusCode":404}`,
			says:   []string{"no progress door", "Upgrade the Orbit server"},
		},
		{
			name:    "a task that is not this owner's",
			status:  http.StatusNotFound,
			reply:   `{"message":"task not found","error":"Not Found","statusCode":404}`,
			says:    []string{"task not found"},
			notSays: "no progress door",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv, _ := watchDoor(t, tc.status, tc.reply)
			result := progressMCP(t, srv.URL).callTool("task_progress_report", map[string]interface{}{"current": float64(5), "expectedRevision": float64(4)})
			text := watchToolText(t, result)
			if result["isError"] != true {
				t.Fatalf("a %d was not reported as an error: %s", tc.status, text)
			}
			for _, phrase := range tc.says {
				if !strings.Contains(text, phrase) {
					t.Errorf("the refusal does not say %q:\n%s", phrase, text)
				}
			}
			if tc.notSays != "" && strings.Contains(text, tc.notSays) {
				t.Errorf("the refusal says %q, which does not apply to it:\n%s", tc.notSays, text)
			}
		})
	}
}

func TestTaskProgressCLIReportsAndReads(t *testing.T) {
	cases := []struct {
		name        string
		args        []string
		method, uri string
		body        map[string]interface{}
	}{
		{
			name:   "a report on the current task",
			args:   []string{"progress", "--phase", "tests", "--current", "3", "--clear-total", "--expected-revision", "3", "--json"},
			method: http.MethodPost,
			uri:    "/api/runner/tasks/task-env/progress",
			body:   map[string]interface{}{"phase": "tests", "current": float64(3), "total": nil, "expectedRevision": float64(3)},
		},
		{
			name:   "a message on a named task",
			args:   []string{"progress", "t9", "--message", "halfway through the fixtures", "--json"},
			method: http.MethodPost,
			uri:    "/api/runner/tasks/t9/progress",
			body:   map[string]interface{}{"message": "halfway through the fixtures"},
		},
		{
			name:   "a read",
			args:   []string{"progress", "t9", "--json"},
			method: http.MethodGet,
			uri:    "/api/runner/tasks/t9/progress",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv, requests := watchDoor(t, http.StatusOK, progressedReply)
			configureProgressCLI(t, srv.URL)
			var out bytes.Buffer
			if err := cmdTaskCLI(tc.args, strings.NewReader(""), &out); err != nil {
				t.Fatal(err)
			}
			if len(*requests) != 1 {
				t.Fatalf("requests = %#v, want one", *requests)
			}
			got := (*requests)[0]
			if got.method != tc.method || got.uri != tc.uri {
				t.Fatalf("request = %s %s, want %s %s", got.method, got.uri, tc.method, tc.uri)
			}
			if !reflect.DeepEqual(got.body, tc.body) {
				t.Fatalf("body = %#v\nwant %#v", got.body, tc.body)
			}
			var printed map[string]interface{}
			if err := json.Unmarshal(out.Bytes(), &printed); err != nil || printed["revision"] != float64(4) {
				t.Fatalf("output = %q (%v), want the answer as it came", out.String(), err)
			}
		})
	}
}

func TestTaskProgressCLIRefusesContradictionsWithoutSending(t *testing.T) {
	srv, requests := watchDoor(t, http.StatusOK, progressedReply)
	configureProgressCLI(t, srv.URL)
	for args, says := range map[string]string{
		"--phase tests --clear-phase": "--phase and --clear-phase contradict each other",
		"--expected-revision 2":       "--expected-revision guards a report",
	} {
		err := cmdTaskCLI(append([]string{"progress"}, strings.Fields(args)...), strings.NewReader(""), io.Discard)
		if err == nil || !strings.Contains(err.Error(), says) {
			t.Errorf("orbit task progress %s = %v, want an error saying %q", args, err, says)
		}
	}
	if len(*requests) != 0 {
		t.Fatalf("a refused command reached the server: %#v", *requests)
	}
}

func TestTaskProgressSurfaceIsTheContracts(t *testing.T) {
	progress := watchContract(t)["progress"].(map[string]interface{})
	limits := map[string]interface{}{
		"maxPhaseChars":   float64(taskProgressMaxPhaseChars),
		"maxMessageChars": float64(taskProgressMaxMessageChars),
		"maxCount":        float64(taskProgressMaxCount),
	}
	if !reflect.DeepEqual(progress["limits"], limits) {
		t.Errorf("progress limits = %#v here, %#v in the contract", limits, progress["limits"])
	}
	door := progress["runnerDoor"].(map[string]interface{})
	if door["tool"] != "task_progress_report" || !hasMCPTool(toolDescriptors(false, false), "task_progress_report") {
		t.Errorf("the contract names the progress tool %v, and every agent must be offered task_progress_report", door["tool"])
	}
	if door["cli"] != "orbit task progress" {
		t.Errorf("the contract names the progress command %v", door["cli"])
	}
	// What the tool sends a read and a report to is what the contract names, and what
	// runner-task-progress.pg.spec.ts serves.
	srv, requests := watchDoor(t, http.StatusOK, progressedReply)
	mcp := progressMCP(t, srv.URL)
	for _, args := range []map[string]interface{}{{}, {"current": float64(1)}} {
		if result := mcp.callTool("task_progress_report", args); result["isError"] == true {
			t.Fatalf("task_progress_report(%v) failed: %s", args, watchToolText(t, result))
		}
	}
	sent := []string{}
	for _, request := range *requests {
		sent = append(sent, request.method+" "+strings.Replace(request.uri, "/task-current/", "/:id/", 1))
	}
	named := []string{}
	for _, route := range door["routes"].([]interface{}) {
		named = append(named, route.(string))
	}
	sort.Strings(sent)
	sort.Strings(named)
	if !reflect.DeepEqual(sent, named) {
		t.Errorf("the tool sends %v, the contract names %v", sent, named)
	}
}

// The text an agent reads before it reports: what progress is, where it comes from, and what a conflict asks for.
func TestTaskProgressAgentTextSaysWhatProgressIs(t *testing.T) {
	var description string
	for _, tool := range toolDescriptors(false, false) {
		if tool["name"] == "task_progress_report" {
			description, _ = tool["description"].(string)
		}
	}
	oneLine := func(text string) string { return strings.Join(strings.Fields(text), " ") }
	for door, phrases := range map[string][]string{
		oneLine(description): {
			"Orbit never infers it from your Bash output, a transcript",
			"Only a change of phase, current or total is progress",
			"on 409 PROGRESS_REVISION_CONFLICT, read it again, then report against the revision it shows",
		},
		oneLine(taskProgressHelp): {
			"Orbit never infers it from shell output or a transcript",
			"Only a change of phase, current or total is progress",
			"PROGRESS_REVISION_CONFLICT means it moved: read the progress again, then report against the revision it shows",
		},
	} {
		for _, phrase := range phrases {
			if !strings.Contains(door, phrase) {
				t.Errorf("%q does not say %q", door, phrase)
			}
		}
	}

	const exe = "/usr/local/bin/orbit"
	inside := orbitCLIInstructions(exe, true, true)
	for _, phrase := range []string{
		"report it with task_progress_report",
		"never from your Bash output or transcript",
		"only a change of phase, current or total counts as progress",
		"409 PROGRESS_REVISION_CONFLICT, read the progress again, then report",
	} {
		if !strings.Contains(inside, phrase) {
			t.Errorf("a task session's instructions do not say %q", phrase)
		}
	}
	if strings.Contains(orbitCLIInstructions(exe, false, true), "task_progress_report") {
		t.Error("a session running no task is told to report a task's progress")
	}
	paragraph := orbitProgressInstructions(true)
	for i := 0; i < len(paragraph); i++ {
		if paragraph[i] > 127 {
			t.Fatalf("the progress paragraph must stay ASCII for codex's context value; byte %d is %q", i, paragraph[i])
		}
	}
	if allowed := strings.Join(orbitCLIAllowedTools(exe, false), "\n"); !strings.Contains(allowed, "Bash("+exe+" task progress *)") {
		t.Error("orbit task progress is not pre-approved for the sessions its instructions send to it")
	}
}
