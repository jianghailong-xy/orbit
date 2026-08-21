package main

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

// `orbit task list` and the task_list tool answer across every project the owner has, so a
// coordinator reading "its" tasks was reading everybody's and filtering by eye — impossible past
// one page, since the newest N tasks on a busy account may contain none of the project's. These
// tests pin the filter to the wire: the scope has to reach the server, on every request the
// command makes, or the answer is wider than it looks.

// captureQueries records the query string of every request, so a filter that is built but never
// sent (or sent on the first page only) fails here rather than reading as an empty project.
func captureQueries(t *testing.T, handler http.HandlerFunc) (*httptest.Server, *[]url.Values) {
	t.Helper()
	var seen []url.Values
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, r.URL.Query())
		handler(w, r)
	}))
	t.Cleanup(srv.Close)
	return srv, &seen
}

func TestTaskCLIListSendsProjectIDOnTheBoundedRead(t *testing.T) {
	srv, seen := captureQueries(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/runner/tasks" {
			t.Errorf("bounded read hit %q", r.URL.Path)
		}
		_, _ = w.Write([]byte(`[{"id":"t1"}]`))
	})
	configureCLITestRunner(t, srv.URL)

	var out bytes.Buffer
	if err := cmdTaskCLI([]string{"list", "--project-id", "proj-1", "--json"}, strings.NewReader(""), &out); err != nil {
		t.Fatal(err)
	}

	if len(*seen) != 1 {
		t.Fatalf("requests = %d", len(*seen))
	}
	if got := (*seen)[0].Get("projectId"); got != "proj-1" {
		t.Fatalf("projectId = %q, query = %v", got, (*seen)[0])
	}
}

// A filter that only narrows one axis is a filter that answers a different question than the one
// asked: --project-id with --status OPEN must mean "open work in this project", not "this
// project's tasks" and not "every open task".
func TestTaskCLIListCombinesProjectIDWithTheOtherFilters(t *testing.T) {
	srv, seen := captureQueries(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`[]`))
	})
	configureCLITestRunner(t, srv.URL)

	var out bytes.Buffer
	err := cmdTaskCLI([]string{
		"list",
		"--status", "OPEN",
		"--list-id", "list-1",
		"--project-id", "proj-1",
		"--label", "shard-3",
		"--label", "CC-MAIN-2017-34",
		"--limit", "25",
		"--json",
	}, strings.NewReader(""), &out)
	if err != nil {
		t.Fatal(err)
	}

	q := (*seen)[0]
	if q.Get("status") != "OPEN" || q.Get("listId") != "list-1" || q.Get("projectId") != "proj-1" || q.Get("limit") != "25" {
		t.Fatalf("query lost a filter: %v", q)
	}
	if labels := q["labels"]; len(labels) != 2 || labels[0] != "shard-3" || labels[1] != "CC-MAIN-2017-34" {
		t.Fatalf("labels = %v", labels)
	}
}

// The walk is where a dropped filter does the most damage: page 1 is the project's, and every
// page after it is the whole account — with nothing in the output saying so.
func TestTaskCLIListAllCarriesProjectIDOnEveryPage(t *testing.T) {
	srv, seen := captureQueries(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Query().Get("cursor") {
		case "":
			_, _ = w.Write([]byte(`{"items":[{"id":"t1"}],"nextCursor":"c2"}`))
		case "c2":
			_, _ = w.Write([]byte(`{"items":[{"id":"t2"}],"nextCursor":"c3"}`))
		case "c3":
			_, _ = w.Write([]byte(`{"items":[{"id":"t3"}],"nextCursor":null}`))
		default:
			t.Errorf("unexpected cursor %q", r.URL.Query().Get("cursor"))
		}
	})
	configureCLITestRunner(t, srv.URL)

	var out bytes.Buffer
	err := cmdTaskCLI([]string{"list", "--project-id", "proj-1", "--status", "OPEN", "--all"},
		strings.NewReader(""), &out)
	if err != nil {
		t.Fatal(err)
	}

	if rows := decodeNDJSON(t, out.String()); len(rows) != 3 {
		t.Fatalf("rows = %v", rows)
	}
	if len(*seen) != 3 {
		t.Fatalf("requests = %d", len(*seen))
	}
	for i, q := range *seen {
		if q.Get("projectId") != "proj-1" || q.Get("status") != "OPEN" {
			t.Fatalf("page %d widened the scope: %v", i+1, q)
		}
	}
	// The cursor still advances the walk: the scope rides along with it, not instead of it.
	if (*seen)[1].Get("cursor") != "c2" || (*seen)[2].Get("cursor") != "c3" {
		t.Fatalf("cursors = %v, %v", (*seen)[1], (*seen)[2])
	}
}

// An interrupted walk is resumed with --cursor and the same filters typed again; the scope has to
// survive that hand-off or the resumed half of the answer is the whole account.
func TestTaskCLIListAllResumesFromACursorWithinTheProject(t *testing.T) {
	srv, seen := captureQueries(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"items":[{"id":"t9"}],"nextCursor":null}`))
	})
	configureCLITestRunner(t, srv.URL)

	var out bytes.Buffer
	err := cmdTaskCLI([]string{"list", "--project-id", "proj-1", "--all", "--cursor", "c7"},
		strings.NewReader(""), &out)
	if err != nil {
		t.Fatal(err)
	}

	q := (*seen)[0]
	if q.Get("cursor") != "c7" || q.Get("projectId") != "proj-1" {
		t.Fatalf("resumed request = %v", q)
	}
}

// A failing page prints the cursor to resume from, and nothing about the scope changes when it
// does — the caller retypes the same filters against the same walk.
func TestTaskCLIListAllReportsTheResumeCursorWhenAProjectWalkFails(t *testing.T) {
	srv, _ := captureQueries(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("cursor") == "c2" {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"statusCode":400,"message":"invalid project id"}`))
			return
		}
		_, _ = w.Write([]byte(`{"items":[{"id":"t1"}],"nextCursor":"c2"}`))
	})
	configureCLITestRunner(t, srv.URL)

	var out bytes.Buffer
	err := cmdTaskCLI([]string{"list", "--project-id", "proj-1", "--all"}, strings.NewReader(""), &out)
	if err == nil || !strings.Contains(err.Error(), "list tasks") {
		t.Fatalf("err = %v", err)
	}
	// Whatever printed before the failure stays printed and stays valid NDJSON.
	if rows := decodeNDJSON(t, out.String()); len(rows) != 1 || rows[0]["id"] != "t1" {
		t.Fatalf("rows = %v", rows)
	}
}

// Omitting the flag must leave the parameter off the wire entirely: an empty projectId= would be
// a filter the server has to decide the meaning of, and the answer today is "no such project".
func TestTaskCLIListOmitsProjectIDWhenNotAsked(t *testing.T) {
	srv, seen := captureQueries(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`[]`))
	})
	configureCLITestRunner(t, srv.URL)

	var out bytes.Buffer
	if err := cmdTaskCLI([]string{"list", "--json"}, strings.NewReader(""), &out); err != nil {
		t.Fatal(err)
	}

	if _, present := (*seen)[0]["projectId"]; present {
		t.Fatalf("projectId sent without the flag: %v", (*seen)[0])
	}
}

func TestMCPTaskListTakesAProjectID(t *testing.T) {
	props := mcpToolProps(toolDescriptors(false, false), "task_list")
	projectID, _ := props["projectId"].(map[string]interface{})
	if projectID["type"] != "string" {
		t.Fatalf("task_list projectId schema = %#v", props["projectId"])
	}
	// Optional, unlike project_get's: a task_list with no project is still the useful whole-account
	// read it has always been.
	for _, tool := range toolDescriptors(false, false) {
		if tool["name"] != "task_list" {
			continue
		}
		schema, _ := tool["inputSchema"].(map[string]interface{})
		if _, required := schema["required"]; required {
			t.Fatalf("task_list made an argument required: %#v", schema["required"])
		}
		// The model has to be able to tell this from project_get, and to know that an id it
		// invented answers empty rather than erroring.
		description, _ := tool["description"].(string)
		if !strings.Contains(description, "projectId") {
			t.Fatalf("task_list description does not mention projectId: %q", description)
		}
	}
}

func TestMCPTaskListSendsTheProjectIDToTheServer(t *testing.T) {
	srv, seen := captureQueries(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`[{"id":"t1"}]`))
	})

	mcp := &mcpServer{t: NewTransport(srv.URL, "tok")}
	res := mcp.callTool("task_list", map[string]interface{}{
		"projectId": "proj-1",
		"status":    "OPEN",
	})
	if res["isError"] == true {
		t.Fatalf("task_list returned an error: %#v", res["content"])
	}

	q := (*seen)[0]
	if q.Get("projectId") != "proj-1" || q.Get("status") != "OPEN" {
		t.Fatalf("task_list query = %v", q)
	}
}

// A project id the model made up is a filter that matches nothing, which the server answers as an
// empty list — the tool must pass that through as a result rather than dressing it as a failure.
func TestMCPTaskListAnswersAnUnknownProjectAsAnEmptyList(t *testing.T) {
	srv, _ := captureQueries(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`[]`))
	})

	mcp := &mcpServer{t: NewTransport(srv.URL, "tok")}
	res := mcp.callTool("task_list", map[string]interface{}{"projectId": "proj-nobody-has"})
	if res["isError"] == true {
		t.Fatalf("an empty project read as an error: %#v", res["content"])
	}
	content, _ := res["content"].([]map[string]interface{})
	if text, _ := content[0]["text"].(string); !strings.Contains(text, "[]") {
		t.Fatalf("task_list result = %q", text)
	}
}

// A rejected id is the server's answer, not something to swallow: a 400 has to reach the model as
// an error result, or a mistyped project reads as a project with no work in it.
func TestMCPTaskListReportsARejectedProjectID(t *testing.T) {
	srv, _ := captureQueries(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"statusCode":400,"message":"invalid projectId"}`))
	})

	mcp := &mcpServer{t: NewTransport(srv.URL, "tok")}
	res := mcp.callTool("task_list", map[string]interface{}{"projectId": "not-an-id!"})
	if res["isError"] != true {
		t.Fatalf("a 400 project filter isError = %#v", res["isError"])
	}
	content, _ := res["content"].([]map[string]interface{})
	text, _ := content[0]["text"].(string)
	if !strings.Contains(text, "list tasks failed") || !strings.Contains(text, "400") {
		t.Fatalf("task_list 400 result = %q", text)
	}
}

// `orbit capabilities` is how an agent finds the CLI door; the parity test next door checks it
// against the MCP schema, and this pins the one flag that door has to advertise.
func TestTaskListCapabilitiesAdvertiseTheProjectFlag(t *testing.T) {
	var spec cliCapabilitySpec
	for _, candidate := range baseCLICapabilities {
		if candidate.Tool == "task_list" {
			spec = candidate
		}
	}
	if spec.Tool == "" {
		t.Fatal("task_list has no CLI capability")
	}
	if !strings.Contains(spec.Usage, "--project-id") {
		t.Fatalf("task_list usage = %q", spec.Usage)
	}
	if !strings.Contains(strings.Join(spec.Arguments, " "), "--project-id") {
		t.Fatalf("task_list arguments = %v", spec.Arguments)
	}
}
