package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// A task filed under the wrong project could not be moved back from any agent-facing door.
//
// `UpdateTaskDto` has taken `projectId` all along — null detaches, a string re-files — and the
// server answered a hand-written PATCH with 200. What did not exist was the client half: MCP's
// `task_update` copied every other field and not this one, and `orbit task update` had no flag for
// it at all. So work the SERVER had filed by inference (a coordinator's session, not the caller's
// word) was frozen where it landed, and correcting it meant a person with curl.
//
// The distinction below is three-way for the same reason `criterionKey`'s is: absent means "leave
// the filing alone", a string means "it belongs to that project now", and null means "it belongs to
// no project". A null flattened into an omission is a detach that silently did nothing and reported
// success — which is exactly the state this whole change exists to make correctable — so the null
// case is asserted against the wire rather than against a map that cannot tell nil from missing.

// captureUpdateRawBody stands in for PATCH /runner/tasks/<id> and keeps the request BYTES. Separate
// from captureUpdateBody next door because "the key is present and its value is null" is a fact
// about the JSON, and a decoded map answers it only for a reader who remembers to ask twice.
func captureUpdateRawBody(t *testing.T) (*httptest.Server, *[][]byte) {
	t.Helper()
	var raws [][]byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPatch {
			t.Errorf("method = %s, want PATCH", r.Method)
		}
		raw, _ := io.ReadAll(r.Body)
		raws = append(raws, raw)
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"id":"task-1"}`))
	}))
	t.Cleanup(srv.Close)
	return srv, &raws
}

// The whole three-state contract at the MCP door, one row per state. The middle row is the one that
// fails on a copy helper written as `if v != nil`: a JSON null arrives as a present key holding a
// nil interface, and a copy that tests the VALUE instead of the presence drops it — leaving the
// detach unexpressible from the tool that is supposed to express it.
func TestMCPTaskUpdateSendsProjectIDOmittedNullAndNamed(t *testing.T) {
	for _, tc := range []struct {
		name    string
		args    map[string]interface{}
		present bool
		want    string
	}{
		{
			name:    "omitted leaves the filing alone",
			args:    map[string]interface{}{"taskId": "t1", "status": "IN_PROGRESS"},
			present: false,
		},
		{
			name:    "null takes it out of every project",
			args:    map[string]interface{}{"taskId": "t1", "projectId": nil},
			present: true,
			want:    `"projectId":null`,
		},
		{
			name:    "a string re-files it there",
			args:    map[string]interface{}{"taskId": "t1", "projectId": "3CuIHiSJZBQ7nLVUwc7ekz"},
			present: true,
			want:    `"projectId":"3CuIHiSJZBQ7nLVUwc7ekz"`,
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
			value, present := body["projectId"]
			if present != tc.present {
				t.Fatalf("projectId present = %v, want %v: %s", present, tc.present, raw)
			}
			if !tc.present {
				return
			}
			// Asserted on the bytes, not on the map: `map[string]interface{}{"projectId": nil}`
			// and a body that omits the key entirely are the same `value == nil` to a reader that
			// only looks at the value, and they mean opposite things to the server.
			if !strings.Contains(string(raw), tc.want) {
				t.Fatalf("body = %s, want it to contain %s", raw, tc.want)
			}
			if tc.want == `"projectId":null` && value != nil {
				t.Fatalf("projectId = %#v, want null", value)
			}
		})
	}
}

// The schema is what a model reads before it writes anything: a `projectId` typed "string" tells it
// the detach it needs does not exist, which is the state this change is undoing. Same shape as
// `criterionKey` next to it, and the description has to name the boundary a move can meet, because
// the caller cannot discover it any other way until it is refused.
func TestMCPTaskUpdateDeclaresNullableProjectID(t *testing.T) {
	tools := toolDescriptors(false, false)
	props := mcpToolProps(tools, "task_update")

	project, ok := props["projectId"].(map[string]interface{})
	if !ok {
		t.Fatalf("task_update has no projectId property: %#v", props["projectId"])
	}
	types, ok := project["type"].([]string)
	if !ok || len(types) != 2 || types[0] != "string" || types[1] != "null" {
		t.Fatalf("projectId type = %#v, want [string null]", project["type"])
	}
	// The same nullability `criterionKey` carries on this door, and for the same reason: on an
	// update there is an existing value, so "take it back" has to be sayable.
	criterion, _ := props["criterionKey"].(map[string]interface{})
	criterionTypes, _ := criterion["type"].([]string)
	if len(criterionTypes) != len(types) || criterionTypes[0] != types[0] || criterionTypes[1] != types[1] {
		t.Fatalf("projectId type %#v does not match criterionKey's %#v", types, criterionTypes)
	}

	for _, tool := range tools {
		if tool["name"] != "task_update" {
			continue
		}
		schema, _ := tool["inputSchema"].(map[string]interface{})
		required, _ := schema["required"].([]string)
		for _, field := range required {
			if field == "projectId" {
				t.Fatal("task_update made projectId required")
			}
		}
	}

	text, _ := project["description"].(string)
	// Each outcome is a different sentence the caller has to be told, and then the asymmetry that
	// only the server knows: BOTH halves of this field are the account owner's, and a session
	// acting under a project scope meets a different refusal for each. A description that promised
	// an agent it could unfile its own work would be read once and believed.
	for _, want := range []string{
		"Omit", "null", "UNMAPPED_PROJECT_WORK", "PROJECT_SCOPE_MISMATCH",
		"CROSS_PROJECT_APPROVAL_REQUIRED", "APPROVAL_PENDING", "project_crossings", "OWNER",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("projectId description does not state %q: %q", want, text)
		}
	}
}

// The CLI half of the same contract, asserted on the request body rather than on the flag
// variables: a flag that is parsed and never reaches the body is a flag that reports success and
// changes nothing.
func TestTaskCLIUpdateSendsProjectIDForBothFlags(t *testing.T) {
	for _, tc := range []struct {
		name string
		args []string
		want string
	}{
		{
			name: "--no-project detaches",
			args: []string{"update", "task-1", "--no-project", "--json"},
			want: `"projectId":null`,
		},
		{
			name: "--project re-files",
			args: []string{"update", "task-1", "--project", "34IUpy9PJxnqgJ6TGHP24", "--json"},
			want: `"projectId":"34IUpy9PJxnqgJ6TGHP24"`,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv, raws := captureUpdateRawBody(t)
			configureCLITestRunner(t, srv.URL)

			var out bytes.Buffer
			if err := cmdTaskCLI(tc.args, strings.NewReader(""), &out); err != nil {
				t.Fatal(err)
			}

			if len(*raws) != 1 {
				t.Fatalf("requests = %d", len(*raws))
			}
			raw := (*raws)[0]
			if !strings.Contains(string(raw), tc.want) {
				t.Fatalf("body = %s, want it to contain %s", raw, tc.want)
			}
			var body map[string]interface{}
			if err := json.Unmarshal(raw, &body); err != nil {
				t.Fatal(err)
			}
			// A move is one field's worth of edit: a body carrying anything else would rewrite
			// whatever it names on a PATCH that only meant to re-file the task.
			if len(body) != 1 {
				t.Fatalf("the move sent fields nobody asked for: %#v", body)
			}
		})
	}
}

// Two opposite instructions about one field. There is no preference order to apply — "put it there"
// and "put it nowhere" cannot both be honoured — so this is refused locally, before the round trip,
// rather than resolved by whichever branch happens to run second.
func TestTaskCLIUpdateRefusesProjectAndNoProjectTogether(t *testing.T) {
	var requests int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests++
		_, _ = w.Write([]byte(`{"id":"task-1"}`))
	}))
	defer srv.Close()
	configureCLITestRunner(t, srv.URL)

	var out bytes.Buffer
	err := cmdTaskCLI([]string{
		"update", "task-1", "--project", "34IUpy9PJxnqgJ6TGHP24", "--no-project", "--json",
	}, strings.NewReader(""), &out)
	if err == nil || !strings.Contains(err.Error(), "--no-project and --project cannot be used together") {
		t.Fatalf("err = %v, want the pair refused", err)
	}
	if requests != 0 {
		t.Fatalf("requests = %d, want the conflict caught before the round trip", requests)
	}
}

// Blank is a typo or an unset shell variable, not a detach — the same rule every other id flag on
// this command uses, and the reason --no-project has to be spelled out loud.
func TestTaskCLIUpdateRefusesABlankProject(t *testing.T) {
	configureCLITestRunner(t, "http://127.0.0.1:1")

	var out bytes.Buffer
	err := cmdTaskCLI([]string{"update", "task-1", "--project", "", "--json"},
		strings.NewReader(""), &out)
	if err == nil || !strings.Contains(err.Error(), "--project cannot be empty; use --no-project") {
		t.Fatalf("err = %v", err)
	}
}

// Moving work INTO another project is a question for the account owner, and the server says so with
// a code. That code is what a caller matches on and the crossing row is where the question lives, so
// both have to survive the trip back through the client: a "request failed" here is a caller that
// retries the same write forever, and a reworded refusal is a second vocabulary for a boundary that
// already has one.
func TestTaskUpdateSurfacesTheCrossProjectRefusalAndWhereToReadIt(t *testing.T) {
	// The body the server actually sends: `scopeRefusalBody` for R10, as ForbiddenException renders
	// it. Nothing in it names a TOOL — that address is the client's to add.
	refusal := `{"code":"CROSS_PROJECT_APPROVAL_REQUIRED","rule":"R10_NO_APPROVAL",` +
		`"responsible":"USER","requiredAction":"AWAIT_HANDOFF_APPROVAL",` +
		`"blockerKind":"AWAITING_USER_APPROVAL",` +
		`"message":"CROSS_PROJECT_APPROVAL_REQUIRED (scope 3Cu → project 34I): Wait for the user ` +
		`to answer the declared crossing.","handoffId":"7XodTllOWqv8RMhrbpzDEn",` +
		`"handoffState":"PENDING"}`

	assertCarriesTheRefusal := func(t *testing.T, text string) {
		t.Helper()
		// The code itself, not a paraphrase: it is the stable name of this boundary.
		if !strings.Contains(text, "CROSS_PROJECT_APPROVAL_REQUIRED") {
			t.Fatalf("the refusal code did not reach the caller: %q", text)
		}
		// And the sentence the server wrote, so nothing is being summarised away.
		if !strings.Contains(text, "Wait for the user to answer the declared crossing.") {
			t.Fatalf("the server's own message did not reach the caller: %q", text)
		}
		// The one thing the server cannot say: where the crossing it named can be read.
		if !strings.Contains(text, "project_crossings") {
			t.Fatalf("the caller was not told where to read the crossing: %q", text)
		}
		if strings.Contains(text, "request failed") {
			t.Fatalf("the refusal was replaced with a generic failure: %q", text)
		}
	}

	newServer := func(t *testing.T) *httptest.Server {
		t.Helper()
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("content-type", "application/json")
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(refusal))
		}))
		t.Cleanup(srv.Close)
		return srv
	}

	t.Run("cli", func(t *testing.T) {
		srv := newServer(t)
		configureCLITestRunner(t, srv.URL)

		var out bytes.Buffer
		err := cmdTaskCLI([]string{
			"update", "task-1", "--project", "34IUpy9PJxnqgJ6TGHP24", "--json",
		}, strings.NewReader(""), &out)
		if err == nil {
			t.Fatal("a refused move reported success")
		}
		assertCarriesTheRefusal(t, err.Error())
	})

	t.Run("mcp", func(t *testing.T) {
		srv := newServer(t)

		mcp := &mcpServer{agentID: "agent-1", t: NewTransport(srv.URL, "tok")}
		res := mcp.callTool("task_update", map[string]interface{}{
			"taskId": "t1", "projectId": "34IUpy9PJxnqgJ6TGHP24",
		})
		if res["isError"] != true {
			t.Fatalf("a refused move was reported as a success: %#v", res["content"])
		}
		content, ok := res["content"].([]map[string]interface{})
		if !ok || len(content) != 1 {
			t.Fatalf("tool content = %#v", res["content"])
		}
		text, _ := content[0]["text"].(string)
		assertCarriesTheRefusal(t, text)
	})

	// The negative control: the pointer is attached to the two refusals that are ABOUT a crossing,
	// not to every failure a move can meet. A guidance line under an unrelated 404 sends the caller
	// to read a row that does not exist.
	t.Run("only the crossing refusals get the pointer", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("content-type", "application/json")
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"code":"NOT_FOUND","message":"task not found"}`))
		}))
		defer srv.Close()
		configureCLITestRunner(t, srv.URL)

		var out bytes.Buffer
		err := cmdTaskCLI([]string{"update", "task-1", "--no-project", "--json"},
			strings.NewReader(""), &out)
		if err == nil {
			t.Fatal("a 404 reported success")
		}
		if strings.Contains(err.Error(), "project_crossings") {
			t.Fatalf("an unrelated refusal was decorated with the crossing pointer: %q", err)
		}
	})
}

// `orbit capabilities --json` hands this text to an agent that has never typed the command, and it
// is the only place the asymmetry is stated before it is met: detaching is free, re-filing is a
// question somebody else answers. Help that stayed quiet about it would leave a coordinator
// treating CROSS_PROJECT_APPROVAL_REQUIRED as a bug in its own request.
func TestTaskUpdateHelpSaysACrossProjectMoveNeedsTheOwner(t *testing.T) {
	help := taskActionHelp["update"]
	for _, want := range []string{"--project", "--no-project"} {
		if !strings.Contains(help, want) {
			t.Fatalf("`orbit task update --help` does not document %s", want)
		}
	}
	// The --project paragraph specifically: the note has to sit where somebody reading about the
	// flag will meet it, not in a footer under another field.
	section := help[strings.Index(help, "--project PROJECT_ID"):]
	section = section[:strings.Index(section, "--no-project")]
	for _, want := range []string{
		"CROSS_PROJECT_APPROVAL_REQUIRED", "APPROVAL_PENDING", "PROJECT_SCOPE_MISMATCH",
		"ACCOUNT OWNER", "project crossings",
	} {
		if !strings.Contains(section, want) {
			t.Fatalf("the --project help does not say %q: %q", want, section)
		}
	}
	// ...and the detach half says what IT meets, which is a different refusal for a different
	// reason: no approval is pending on it, and a session still may not leave work under no goal.
	// One sentence covering both halves would be wrong about whichever it was not written for.
	detach := help[strings.Index(help, "--no-project"):]
	detach = detach[:strings.Index(detach, "--parent-task-id")]
	for _, want := range []string{"UNMAPPED_PROJECT_WORK", "ACCOUNT OWNER"} {
		if !strings.Contains(detach, want) {
			t.Fatalf("the --no-project help does not say %q: %q", want, detach)
		}
	}

	var spec cliCapabilitySpec
	for _, candidate := range baseCLICapabilities {
		if candidate.Tool == "task_update" {
			spec = candidate
		}
	}
	documented := strings.Join(spec.Arguments, " ")
	for _, want := range []string{
		"--project <id> | --no-project", "UNMAPPED_PROJECT_WORK", "PROJECT_SCOPE_MISMATCH",
		"CROSS_PROJECT_APPROVAL_REQUIRED", "APPROVAL_PENDING", "ACCOUNT OWNER", "project crossings",
	} {
		if !strings.Contains(documented, want) {
			t.Fatalf("`orbit capabilities` does not state %q for task_update: %q", want, documented)
		}
	}
}
