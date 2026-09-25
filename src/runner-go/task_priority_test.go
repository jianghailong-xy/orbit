package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// UpdateTaskDto.priority is three-state on the wire — absent keeps it, null returns it to the
// default 0, an integer sets it — and a field the task_update copy list does not name never leaves
// this process: the server's ValidationPipe strips an unknown property rather than refusing it, so a
// dropped priority reports success and changes nothing. These pin both doors to the bytes they send.

func TestMCPTaskUpdateSendsPriorityOmittedNullAndNumber(t *testing.T) {
	for _, tc := range []struct {
		name    string
		args    map[string]interface{}
		present bool
		want    string
	}{
		{
			name:    "omitted keeps it",
			args:    map[string]interface{}{"taskId": "t1", "title": "Renamed"},
			present: false,
		},
		{
			name:    "null returns it to the default",
			args:    map[string]interface{}{"taskId": "t1", "priority": nil},
			present: true,
			want:    `"priority":null`,
		},
		{
			name:    "a number sets it",
			args:    map[string]interface{}{"taskId": "t1", "priority": float64(82)},
			present: true,
			want:    `"priority":82`,
		},
		{
			name:    "zero is sent, not dropped as a zero value",
			args:    map[string]interface{}{"taskId": "t1", "priority": float64(0)},
			present: true,
			want:    `"priority":0`,
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
			if _, present := body["priority"]; present != tc.present {
				t.Fatalf("priority present = %v, want %v: %s", present, tc.present, raw)
			}
			if tc.present && !strings.Contains(string(raw), tc.want) {
				t.Fatalf("body = %s, want it to contain %s", raw, tc.want)
			}
		})
	}
}

// A model reads the schema before it writes: priority has to be declared as a nullable integer in
// the column's range, and the description has to say what it orders, what it does not do, and what
// null means — none of which the success of the write would tell it.
func TestMCPTaskUpdateDeclaresPriority(t *testing.T) {
	props := mcpToolProps(toolDescriptors(false, false), "task_update")
	priority, ok := props["priority"].(map[string]interface{})
	if !ok {
		t.Fatalf("task_update declares no priority: %#v", props["priority"])
	}
	types, _ := priority["type"].([]string)
	if len(types) != 2 || types[0] != "integer" || types[1] != "null" {
		t.Fatalf("priority type = %#v, want [integer null]", priority["type"])
	}
	if priority["minimum"] != taskPriorityMin || priority["maximum"] != taskPriorityMax {
		t.Fatalf("priority range = %v..%v", priority["minimum"], priority["maximum"])
	}
	description, _ := priority["description"].(string)
	for _, phrase := range []string{
		"list's queue", "free slots", "highest priority first", "0", "Equal priorities",
		"starts nothing", "dispatchHold", "task_start", "null returns the task to 0",
	} {
		if !strings.Contains(description, phrase) {
			t.Errorf("priority description does not state %q: %q", phrase, description)
		}
	}
}

func TestTaskCLIUpdateSendsPriorityClearsItAndOtherwiseLeavesItAlone(t *testing.T) {
	for _, tc := range []struct {
		name    string
		args    []string
		present bool
		want    string
	}{
		{
			name:    "--priority sets it",
			args:    []string{"update", "task-1", "--priority", "82", "--json"},
			present: true,
			want:    `"priority":82`,
		},
		{
			name:    "--priority 0 is sent",
			args:    []string{"update", "task-1", "--priority", "0", "--json"},
			present: true,
			want:    `"priority":0`,
		},
		{
			name:    "a negative priority is sent",
			args:    []string{"update", "task-1", "--priority=-3", "--json"},
			present: true,
			want:    `"priority":-3`,
		},
		{
			name:    "--clear-priority returns it to the default",
			args:    []string{"update", "task-1", "--clear-priority", "--json"},
			present: true,
			want:    `"priority":null`,
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
			if _, present := body["priority"]; present != tc.present {
				t.Fatalf("priority present = %v, want %v: %s", present, tc.present, raw)
			}
			if tc.present && !strings.Contains(string(raw), tc.want) {
				t.Fatalf("body = %s, want it to contain %s", raw, tc.want)
			}
		})
	}
}

// Opposite instructions about one field, and a number the column cannot hold, are caught before any
// request — the treatment --clear-run-at/--run-at already get.
func TestTaskCLIPriorityRefusesContradictionsAndOutOfRangeBeforeTheRoundTrip(t *testing.T) {
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
		{[]string{"update", "task-1", "--priority", "5", "--clear-priority", "--json"}, "--clear-priority and --priority cannot be used together"},
		{[]string{"update", "task-1", "--priority", "2147483648", "--json"}, "--priority must be between -2147483648 and 2147483647"},
		{[]string{"update", "task-1", "--priority", "high", "--json"}, "invalid value"},
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

// ── minPriority on the read doors ───────────────────────────────────────────────────────────────
//
// `task_list` / `orbit task list` with a floor: sent as the `minPriority` query parameter when it
// was named — 0 included, since 0 is a floor a caller can mean — and on EVERY page of an --all walk,
// because a filter dropped after page one silently widens the walk to the whole list. A floor that
// is not an integer in the column's range is refused here, before any request.

// captureTaskListQueries answers the two list routes and records the query of every request.
// The page route answers two pages, so a walk has to carry its filters across a cursor.
func captureTaskListQueries(t *testing.T) (*httptest.Server, *[]map[string][]string) {
	t.Helper()
	var queries []map[string][]string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		queries = append(queries, map[string][]string(r.URL.Query()))
		switch r.URL.Path {
		case "/api/runner/tasks":
			_, _ = w.Write([]byte(`[{"id":"t1","priority":7}]`))
		case "/api/runner/tasks/page":
			if r.URL.Query().Get("cursor") == "" {
				_, _ = w.Write([]byte(`{"items":[{"id":"t1","priority":7}],"nextCursor":"c2"}`))
			} else {
				_, _ = w.Write([]byte(`{"items":[{"id":"t2","priority":3}],"nextCursor":null}`))
			}
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv, &queries
}

func TestMCPTaskListSendsMinPriorityOnlyWhenNamed(t *testing.T) {
	for _, tc := range []struct {
		name string
		args map[string]interface{}
		want []string // nil = the parameter must be absent
	}{
		{name: "absent", args: map[string]interface{}{"listId": "L1"}},
		{name: "null", args: map[string]interface{}{"listId": "L1", "minPriority": nil}},
		{name: "raised only", args: map[string]interface{}{"listId": "L1", "minPriority": float64(1)}, want: []string{"1"}},
		{name: "zero is a floor", args: map[string]interface{}{"minPriority": float64(0)}, want: []string{"0"}},
		{name: "negative", args: map[string]interface{}{"minPriority": float64(-5)}, want: []string{"-5"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv, queries := captureTaskListQueries(t)
			mcp := &mcpServer{agentID: "agent-1", t: NewTransport(srv.URL, "tok")}
			res := mcp.callTool("task_list", tc.args)
			if res["isError"] == true {
				t.Fatalf("task_list returned an error: %#v", res["content"])
			}
			if len(*queries) != 1 {
				t.Fatalf("requests = %d", len(*queries))
			}
			got, present := (*queries)[0]["minPriority"]
			if (tc.want == nil) == present || (tc.want != nil && strings.Join(got, ",") != strings.Join(tc.want, ",")) {
				t.Fatalf("minPriority = %v (present %v), want %v; query = %v", got, present, tc.want, (*queries)[0])
			}
		})
	}
}

func TestMCPTaskListRefusesAFloorOutsideTheColumnBeforeAnyRequest(t *testing.T) {
	srv, queries := captureTaskListQueries(t)
	mcp := &mcpServer{agentID: "agent-1", t: NewTransport(srv.URL, "tok")}
	for _, bad := range []interface{}{1.5, float64(2147483648), float64(-2147483649), "high", true} {
		res := mcp.callTool("task_list", map[string]interface{}{"minPriority": bad})
		if res["isError"] != true {
			t.Fatalf("minPriority %#v was accepted: %#v", bad, res["content"])
		}
	}
	if len(*queries) != 0 {
		t.Fatalf("requests = %d, want every refusal before the round trip", len(*queries))
	}
}

func TestMCPTaskListDeclaresMinPriority(t *testing.T) {
	props := mcpToolProps(toolDescriptors(false, false), "task_list")
	floor, ok := props["minPriority"].(map[string]interface{})
	if !ok {
		t.Fatalf("task_list declares no minPriority: %#v", props["minPriority"])
	}
	if floor["type"] != "integer" || floor["minimum"] != taskPriorityMin || floor["maximum"] != taskPriorityMax {
		t.Fatalf("minPriority = %#v, want an integer in the column's range", floor)
	}
	description, _ := floor["description"].(string)
	for _, phrase := range []string{"at least", "1 is", "somebody raised", "negative", "Omit"} {
		if !strings.Contains(description, phrase) {
			t.Errorf("minPriority description does not state %q: %q", phrase, description)
		}
	}
}

func TestTaskCLIListSendsMinPriorityOnEveryPage(t *testing.T) {
	t.Run("one page", func(t *testing.T) {
		srv, queries := captureTaskListQueries(t)
		configureCLITestRunner(t, srv.URL)
		var out bytes.Buffer
		if err := cmdTaskCLI([]string{"list", "--list-id", "L1", "--status", "OPEN", "--min-priority", "1", "--json"}, strings.NewReader(""), &out); err != nil {
			t.Fatal(err)
		}
		if len(*queries) != 1 || strings.Join((*queries)[0]["minPriority"], ",") != "1" {
			t.Fatalf("queries = %v, want one request with minPriority=1", *queries)
		}
	})
	t.Run("an --all walk carries it across the cursor", func(t *testing.T) {
		srv, queries := captureTaskListQueries(t)
		configureCLITestRunner(t, srv.URL)
		var out bytes.Buffer
		if err := cmdTaskCLI([]string{"list", "--list-id", "L1", "--min-priority", "0", "--all"}, strings.NewReader(""), &out); err != nil {
			t.Fatal(err)
		}
		if len(*queries) != 2 {
			t.Fatalf("requests = %d, want two pages", len(*queries))
		}
		for i, q := range *queries {
			if strings.Join(q["minPriority"], ",") != "0" {
				t.Fatalf("page %d query = %v, want minPriority=0 on every page", i+1, q)
			}
		}
		if lines := strings.Count(strings.TrimSpace(out.String()), "\n") + 1; lines != 2 {
			t.Fatalf("output = %q, want both pages' rows", out.String())
		}
	})
	t.Run("not named, not sent", func(t *testing.T) {
		srv, queries := captureTaskListQueries(t)
		configureCLITestRunner(t, srv.URL)
		var out bytes.Buffer
		if err := cmdTaskCLI([]string{"list", "--list-id", "L1", "--json"}, strings.NewReader(""), &out); err != nil {
			t.Fatal(err)
		}
		if _, present := (*queries)[0]["minPriority"]; present {
			t.Fatalf("query = %v, want no minPriority", (*queries)[0])
		}
	})
}

func TestTaskCLIListRefusesAFloorOutsideTheColumnBeforeAnyRequest(t *testing.T) {
	srv, queries := captureTaskListQueries(t)
	configureCLITestRunner(t, srv.URL)
	for _, tc := range []struct {
		args []string
		want string
	}{
		{[]string{"list", "--min-priority", "2147483648", "--json"}, "--min-priority must be between -2147483648 and 2147483647"},
		{[]string{"list", "--min-priority", "high", "--json"}, "invalid value"},
	} {
		var out bytes.Buffer
		err := cmdTaskCLI(tc.args, strings.NewReader(""), &out)
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Fatalf("%v: err = %v, want %q", tc.args, err, tc.want)
		}
	}
	if len(*queries) != 0 {
		t.Fatalf("requests = %d, want every refusal before the round trip", len(*queries))
	}
}
