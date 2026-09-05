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

// The one field on a task write that only an AGENT can ever need, and the one no agent could send.
//
// §4 R1 exempts the account owner from the whole scope contract, so a crossing is never theirs to
// declare; §4 R7 refuses an agent's crossing that was not declared, and names the remedy in its own
// requiredAction — FILE_IN_OWN_PROJECT_OR_REQUEST_HANDOFF. Both halves of the server were built: the
// gate reads `handoff`, the approval it waits for has a table, two routes and a card. What was
// missing was the sentence in the middle. `handoff` appeared in no copyIfPresent list and in no
// flag, so "request one" named a door with no handle on this side, and every crossing an agent tried
// died at R7 — the production table has never held a row.
//
// So these assert the wire, not the intent: a field that is parsed and then dropped before the body
// reads exactly like a field that was never added.

// captureRawWriteBodies stands in for the task write doors and keeps the request BYTES.
//
// Bytes rather than a decoded map because the property under test is presence: `handoff` absent and
// `handoff` present holding a JSON null are the same `nil` to a reader that only looks at values,
// and only one of them is a declaration.
func captureRawWriteBodies(t *testing.T) (*httptest.Server, *[][]byte) {
	t.Helper()
	var raws [][]byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		raws = append(raws, raw)
		w.Header().Set("content-type", "application/json")
		if strings.HasSuffix(r.URL.Path, "/batch-create") {
			_, _ = w.Write([]byte(`{"tasks":[{"id":"created-task"}]}`))
			return
		}
		_, _ = w.Write([]byte(`{"id":"created-task"}`))
	}))
	t.Cleanup(srv.Close)
	return srv, &raws
}

// One row per write door: give it a declaration and it reaches the server, leave it out and the
// request is byte-for-byte the one this binary sent before the field existed.
func TestMCPTaskWritesCarryTheHandoffDeclarationOnTheWire(t *testing.T) {
	const declared = `"handoff":{"reason":"the fix belongs to the other goal"}`
	handoff := map[string]interface{}{"reason": "the fix belongs to the other goal"}

	for _, tc := range []struct {
		name string
		tool string
		with map[string]interface{}
		bare map[string]interface{}
	}{
		{
			name: "task_create",
			tool: "task_create",
			with: map[string]interface{}{
				"title": "file it over there", "completionCriterion": "EVIDENCE_JUDGMENT",
				"projectId": "34IUpy9PJxnqgJ6TGHP24", "handoff": handoff,
			},
			bare: map[string]interface{}{
				"title": "file it at home", "completionCriterion": "EVIDENCE_JUDGMENT",
				"projectId": "34IUpy9PJxnqgJ6TGHP24",
			},
		},
		{
			name: "task_create_batch",
			tool: "task_create_batch",
			with: map[string]interface{}{"tasks": []interface{}{map[string]interface{}{
				"title": "file it over there", "completionCriterion": "EVIDENCE_JUDGMENT",
				"projectId": "34IUpy9PJxnqgJ6TGHP24", "handoff": handoff,
			}}},
			bare: map[string]interface{}{"tasks": []interface{}{map[string]interface{}{
				"title": "file it at home", "completionCriterion": "EVIDENCE_JUDGMENT",
				"projectId": "34IUpy9PJxnqgJ6TGHP24",
			}}},
		},
		{
			name: "task_update",
			tool: "task_update",
			with: map[string]interface{}{
				"taskId": "t1", "projectId": "34IUpy9PJxnqgJ6TGHP24", "handoff": handoff,
			},
			bare: map[string]interface{}{
				"taskId": "t1", "projectId": "34IUpy9PJxnqgJ6TGHP24",
			},
		},
	} {
		t.Run(tc.name+" sends the declaration it was given", func(t *testing.T) {
			srv, raws := captureRawWriteBodies(t)
			// No session id: task_create_batch asks a human about runs it is about to start, and
			// this is about the bytes, not about the card.
			mcp := &mcpServer{agentID: "agent-1", t: NewTransport(srv.URL, "tok")}

			res := mcp.callTool(tc.tool, tc.with)
			if res["isError"] == true {
				t.Fatalf("%s refused a declared crossing: %#v", tc.tool, res["content"])
			}
			if len(*raws) != 1 {
				t.Fatalf("requests = %d", len(*raws))
			}
			if raw := string((*raws)[0]); !strings.Contains(raw, declared) {
				t.Fatalf("the declaration did not reach the wire: %s", raw)
			}
		})

		t.Run(tc.name+" says nothing about a crossing it was not told about", func(t *testing.T) {
			srv, raws := captureRawWriteBodies(t)
			mcp := &mcpServer{agentID: "agent-1", t: NewTransport(srv.URL, "tok")}

			res := mcp.callTool(tc.tool, tc.bare)
			if res["isError"] == true {
				t.Fatalf("%s refused an ordinary write: %#v", tc.tool, res["content"])
			}
			if len(*raws) != 1 {
				t.Fatalf("requests = %d", len(*raws))
			}
			// The key itself, not its value: presence IS the declaration, so a body carrying
			// `"handoff":null` or `"handoff":{}` would be declaring a crossing nobody asked for.
			if raw := string((*raws)[0]); strings.Contains(raw, "handoff") {
				t.Fatalf("an undeclared write carried the field anyway: %s", raw)
			}
		})
	}
}

// The schema is the whole contract a model reads before it writes anything. A field the server
// accepts and the tool never mentions is, to every caller that has not read the source, a field that
// does not exist — which is the state this change is undoing.
func TestMCPTaskToolsDeclareTheHandoffField(t *testing.T) {
	tools := toolDescriptors(false, false)

	// task_create_batch takes its task fields one level down, inside `tasks.items`: the crossing is
	// a property of the ITEM that crosses, not of the plan that contains it.
	batchItemProps := func() map[string]interface{} {
		for _, tool := range tools {
			if tool["name"] != "task_create_batch" {
				continue
			}
			schema, _ := tool["inputSchema"].(map[string]interface{})
			props, _ := schema["properties"].(map[string]interface{})
			tasks, _ := props["tasks"].(map[string]interface{})
			items, _ := tasks["items"].(map[string]interface{})
			itemProps, _ := items["properties"].(map[string]interface{})
			return itemProps
		}
		return nil
	}

	for name, props := range map[string]map[string]interface{}{
		"task_create":       mcpToolProps(tools, "task_create"),
		"task_update":       mcpToolProps(tools, "task_update"),
		"task_create_batch": batchItemProps(),
	} {
		t.Run(name, func(t *testing.T) {
			handoff, ok := props["handoff"].(map[string]interface{})
			if !ok {
				t.Fatalf("%s does not declare `handoff`; the field is unreachable from this tool", name)
			}
			if handoff["type"] != "object" {
				t.Fatalf("%s handoff type = %#v, want object", name, handoff["type"])
			}
			fields, ok := handoff["properties"].(map[string]interface{})
			if !ok {
				t.Fatalf("%s handoff declares no properties: %#v", name, handoff)
			}
			reason, ok := fields["reason"].(map[string]interface{})
			if !ok {
				t.Fatalf("%s handoff declares no `reason`: %#v", name, fields)
			}
			if reason["type"] != "string" {
				t.Fatalf("%s handoff.reason type = %#v, want string", name, reason["type"])
			}
			// Optional, like the DTO's: presence of the OBJECT is the declaration, so a schema that
			// demanded a sentence would make `{}` — a declaration with nothing to say — unsendable.
			if required, present := handoff["required"]; present {
				if list, ok := required.([]string); !ok || len(list) > 0 {
					t.Fatalf("%s handoff requires %#v; reason is optional", name, required)
				}
			}
			// The three things a caller cannot learn anywhere else: it needs a destination, it
			// grants nothing, and a person answers it.
			description, _ := handoff["description"].(string)
			for _, want := range []string{"projectId", "NO AUTHORITY", "ACCOUNT OWNER", "project_crossings"} {
				if !strings.Contains(strings.ToUpper(description), strings.ToUpper(want)) {
					t.Fatalf("%s handoff description does not say %q: %q", name, want, description)
				}
			}
		})
	}
}

// At a terminal the declaration is one flag, and passing it IS the declaration — there is no second
// switch to forget beside it.
func TestTaskCLIHandoffReasonDeclaresTheCrossing(t *testing.T) {
	for _, tc := range []struct {
		name string
		argv []string
	}{
		{
			name: "create",
			argv: []string{
				"create", "--title", "file it over there",
				"--completion-criterion", "EVIDENCE_JUDGMENT",
				"--project-id", "34IUpy9PJxnqgJ6TGHP24",
				"--handoff-reason", "X", "--json",
			},
		},
		{
			name: "update",
			argv: []string{
				"update", "task-1", "--project", "34IUpy9PJxnqgJ6TGHP24",
				"--handoff-reason", "X", "--json",
			},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv, raws := captureRawWriteBodies(t)
			configureCLITestRunner(t, srv.URL)

			var out bytes.Buffer
			if err := cmdTaskCLI(tc.argv, strings.NewReader(""), &out); err != nil {
				t.Fatal(err)
			}
			if len(*raws) != 1 {
				t.Fatalf("requests = %d", len(*raws))
			}
			raw := string((*raws)[0])
			if !strings.Contains(raw, `"handoff":{"reason":"X"}`) {
				t.Fatalf("--handoff-reason did not reach the wire as a declaration: %s", raw)
			}
			// And it is the object the DTO expects, not a flat string beside the other fields.
			var body struct {
				Handoff *struct {
					Reason string `json:"reason"`
				} `json:"handoff"`
			}
			if err := json.Unmarshal((*raws)[0], &body); err != nil {
				t.Fatal(err)
			}
			if body.Handoff == nil || body.Handoff.Reason != "X" {
				t.Fatalf("handoff = %#v, want {reason: X}", body.Handoff)
			}
		})
	}
}

// A declaration with no destination is not an under-specified request, it is an unanswerable one:
// somebody would be asked to approve moving work into a project nobody named. The DTO says as much
// ("Only meaningful together with an explicit projectId — a crossing has to name where it is
// going"), the create doors refuse it, and the edit door does not read `handoff` at all — so a
// caller who got this wrong would learn it on one door and be met with silence on the other.
//
// Settled here, at every door, before the round trip. This is deliberately NOT the server's
// authority question — WHICH crossings are allowed stays entirely the server's to answer — it is one
// sentence with a missing half.
func TestHandoffWithoutATargetProjectIsRefusedBeforeTheRequest(t *testing.T) {
	assertRefused := func(t *testing.T, text string, requests int) {
		t.Helper()
		if !strings.Contains(text, "name where it is going") {
			t.Fatalf("the refusal does not say what is missing: %q", text)
		}
		if requests != 0 {
			t.Fatalf("requests = %d, want the declaration refused before the round trip", requests)
		}
	}

	t.Run("cli create", func(t *testing.T) {
		srv, raws := captureRawWriteBodies(t)
		configureCLITestRunner(t, srv.URL)

		var out bytes.Buffer
		err := cmdTaskCLI([]string{
			"create", "--title", "crossing to nowhere",
			"--completion-criterion", "EVIDENCE_JUDGMENT",
			"--handoff-reason", "it belongs over there", "--json",
		}, strings.NewReader(""), &out)
		if err == nil {
			t.Fatal("a crossing with no destination was accepted")
		}
		assertRefused(t, err.Error(), len(*raws))
	})

	t.Run("cli update", func(t *testing.T) {
		srv, raws := captureRawWriteBodies(t)
		configureCLITestRunner(t, srv.URL)

		var out bytes.Buffer
		err := cmdTaskCLI([]string{
			"update", "task-1", "--title", "renamed",
			"--handoff-reason", "it belongs over there", "--json",
		}, strings.NewReader(""), &out)
		if err == nil {
			t.Fatal("a crossing with no destination was accepted")
		}
		assertRefused(t, err.Error(), len(*raws))
	})

	// --no-project is a detach, not a destination: R4 refuses work under no goal, and no approval
	// exists that could make "nowhere" the far side of a crossing.
	t.Run("cli update cannot cross into no project", func(t *testing.T) {
		srv, raws := captureRawWriteBodies(t)
		configureCLITestRunner(t, srv.URL)

		var out bytes.Buffer
		err := cmdTaskCLI([]string{
			"update", "task-1", "--no-project",
			"--handoff-reason", "it belongs nowhere", "--json",
		}, strings.NewReader(""), &out)
		if err == nil {
			t.Fatal("a crossing into no project was accepted")
		}
		assertRefused(t, err.Error(), len(*raws))
	})

	// A blank reason is an unset shell variable, not a silent declaration: the flag's whole payload
	// is the sentence somebody reads before answering.
	t.Run("cli create refuses a blank reason", func(t *testing.T) {
		srv, raws := captureRawWriteBodies(t)
		configureCLITestRunner(t, srv.URL)

		var out bytes.Buffer
		err := cmdTaskCLI([]string{
			"create", "--title", "blank", "--completion-criterion", "EVIDENCE_JUDGMENT",
			"--project-id", "34IUpy9PJxnqgJ6TGHP24", "--handoff-reason", "  ", "--json",
		}, strings.NewReader(""), &out)
		if err == nil || !strings.Contains(err.Error(), "--handoff-reason cannot be blank") {
			t.Fatalf("err = %v, want a blank reason refused", err)
		}
		if len(*raws) != 0 {
			t.Fatalf("requests = %d", len(*raws))
		}
	})

	for _, tc := range []struct {
		name string
		tool string
		args map[string]interface{}
	}{
		{
			name: "mcp task_create",
			tool: "task_create",
			args: map[string]interface{}{
				"title": "crossing to nowhere", "completionCriterion": "EVIDENCE_JUDGMENT",
				"handoff": map[string]interface{}{"reason": "it belongs over there"},
			},
		},
		{
			name: "mcp task_create_batch",
			tool: "task_create_batch",
			args: map[string]interface{}{"tasks": []interface{}{map[string]interface{}{
				"title": "crossing to nowhere", "completionCriterion": "EVIDENCE_JUDGMENT",
				"handoff": map[string]interface{}{"reason": "it belongs over there"},
			}}},
		},
		{
			name: "mcp task_update",
			tool: "task_update",
			args: map[string]interface{}{
				"taskId": "t1", "title": "renamed",
				"handoff": map[string]interface{}{"reason": "it belongs over there"},
			},
		},
		{
			name: "mcp task_update into no project",
			tool: "task_update",
			args: map[string]interface{}{
				"taskId": "t1", "projectId": nil,
				"handoff": map[string]interface{}{"reason": "it belongs nowhere"},
			},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv, raws := captureRawWriteBodies(t)
			mcp := &mcpServer{agentID: "agent-1", t: NewTransport(srv.URL, "tok")}

			res := mcp.callTool(tc.tool, tc.args)
			if res["isError"] != true {
				t.Fatalf("a crossing with no destination was accepted: %#v", res["content"])
			}
			content, _ := res["content"].([]map[string]interface{})
			if len(content) != 1 {
				t.Fatalf("tool content = %#v", res["content"])
			}
			text, _ := content[0]["text"].(string)
			assertRefused(t, text, len(*raws))
		})
	}

	// The other half of the same rule: a null `handoff` is how a caller with no absent value spells
	// "no crossing here", and it must not be read as a declaration this client then refuses.
	t.Run("mcp task_update passes a null declaration through", func(t *testing.T) {
		srv, raws := captureRawWriteBodies(t)
		mcp := &mcpServer{agentID: "agent-1", t: NewTransport(srv.URL, "tok")}

		res := mcp.callTool("task_update", map[string]interface{}{
			"taskId": "t1", "title": "renamed", "handoff": nil,
		})
		if res["isError"] == true {
			t.Fatalf("a null handoff was read as a crossing: %#v", res["content"])
		}
		if len(*raws) != 1 {
			t.Fatalf("requests = %d", len(*raws))
		}
	})
}

// R7 is the refusal whose own requiredAction names a remedy nobody could perform:
// FILE_IN_OWN_PROJECT_OR_REQUEST_HANDOFF. Now that requesting one is possible, the refusal has to
// say HOW — otherwise a caller reads "or request a handoff" as prose and retries the identical
// write, which is exactly what production has been doing.
//
// Appended, never substituted: the code and the server's own sentence are what a caller matches on.
func TestR7RefusalTellsTheCallerHowToRequestTheHandoff(t *testing.T) {
	const message = "PROJECT_SCOPE_MISMATCH (scope 3Cu → project 34I): File this work in the project " +
		"this session coordinates, or declare the crossing and ask."
	refusalWith := func(requiredAction string) string {
		body := map[string]interface{}{
			"code":           "PROJECT_SCOPE_MISMATCH",
			"rule":           "R7_UNDECLARED_CROSSING",
			"responsible":    "COORDINATOR",
			"requiredAction": requiredAction,
			"blockerKind":    "SCOPE_VIOLATION",
			"message":        message,
		}
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		return string(raw)
	}

	newServer := func(t *testing.T, body string) *httptest.Server {
		t.Helper()
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("content-type", "application/json")
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(body))
		}))
		t.Cleanup(srv.Close)
		return srv
	}

	// Whatever else is added, the server's own refusal survives it word for word.
	assertCarriesTheRefusal := func(t *testing.T, text string) {
		t.Helper()
		if !strings.Contains(text, "PROJECT_SCOPE_MISMATCH") {
			t.Fatalf("the refusal code did not reach the caller: %q", text)
		}
		if !strings.Contains(text, message) {
			t.Fatalf("the server's own message did not reach the caller verbatim: %q", text)
		}
	}
	assertSaysHowToAsk := func(t *testing.T, text string) {
		t.Helper()
		assertCarriesTheRefusal(t, text)
		for _, want := range []string{"handoff", "--handoff-reason", "ACCOUNT OWNER", "project crossings"} {
			if !strings.Contains(text, want) {
				t.Fatalf("the caller was not told how to ask (%q missing): %q", want, text)
			}
		}
	}

	cliCreate := func(t *testing.T, srv *httptest.Server) string {
		t.Helper()
		configureCLITestRunner(t, srv.URL)
		var out bytes.Buffer
		err := cmdTaskCLI([]string{
			"create", "--title", "over the line", "--completion-criterion", "EVIDENCE_JUDGMENT",
			"--project-id", "34IUpy9PJxnqgJ6TGHP24", "--json",
		}, strings.NewReader(""), &out)
		if err == nil {
			t.Fatal("a refused create reported success")
		}
		return err.Error()
	}
	cliUpdate := func(t *testing.T, srv *httptest.Server) string {
		t.Helper()
		configureCLITestRunner(t, srv.URL)
		var out bytes.Buffer
		err := cmdTaskCLI([]string{
			"update", "task-1", "--project", "34IUpy9PJxnqgJ6TGHP24", "--json",
		}, strings.NewReader(""), &out)
		if err == nil {
			t.Fatal("a refused move reported success")
		}
		return err.Error()
	}
	mcpCreate := func(t *testing.T, srv *httptest.Server) string {
		t.Helper()
		mcp := &mcpServer{agentID: "agent-1", t: NewTransport(srv.URL, "tok")}
		res := mcp.callTool("task_create", map[string]interface{}{
			"title": "over the line", "completionCriterion": "EVIDENCE_JUDGMENT",
			"projectId": "34IUpy9PJxnqgJ6TGHP24",
		})
		if res["isError"] != true {
			t.Fatalf("a refused create was reported as a success: %#v", res["content"])
		}
		content, _ := res["content"].([]map[string]interface{})
		if len(content) != 1 {
			t.Fatalf("tool content = %#v", res["content"])
		}
		text, _ := content[0]["text"].(string)
		return text
	}

	for name, run := range map[string]func(*testing.T, *httptest.Server) string{
		"cli create": cliCreate, "cli update": cliUpdate, "mcp create": mcpCreate,
	} {
		t.Run(name, func(t *testing.T) {
			assertSaysHowToAsk(t, run(t, newServer(t, refusalWith("FILE_IN_OWN_PROJECT_OR_REQUEST_HANDOFF"))))
		})
	}

	// The negative control, and the reason the client matches on the PAIR: this code is R6 and R7
	// today, both of which offer the handoff. The day a rule answers with it and names some other
	// action, advice about declaring a crossing would be the wrong advice — so it is keyed on the
	// action the server actually named, not on the code alone.
	t.Run("another required action under the same code gets no handoff advice", func(t *testing.T) {
		text := cliCreate(t, newServer(t, refusalWith("NAME_OWNING_PROJECT")))
		assertCarriesTheRefusal(t, text)
		if strings.Contains(text, "--handoff-reason") || strings.Contains(text, "to ASK rather than retry") {
			t.Fatalf("an unrelated required action was decorated with the handoff advice: %q", text)
		}
	})

	// And a refusal that is not about scope at all keeps the shape it had.
	t.Run("an unrelated refusal is left alone", func(t *testing.T) {
		srv := newServer(t, `{"code":"NOT_FOUND","message":"task not found"}`)
		configureCLITestRunner(t, srv.URL)
		var out bytes.Buffer
		err := cmdTaskCLI([]string{
			"create", "--title", "x", "--completion-criterion", "EVIDENCE_JUDGMENT", "--json",
		}, strings.NewReader(""), &out)
		if err == nil {
			t.Fatal("a 404 reported success")
		}
		if strings.Contains(err.Error(), "--handoff-reason") {
			t.Fatalf("an unrelated refusal was decorated with the handoff advice: %q", err)
		}
	})
}

// `orbit capabilities --json` and `--help` are where an agent that has never typed the command
// learns the flag exists. A declaration channel nobody can find is the gap this task closes, one
// layer up.
func TestTaskCLIDocumentsHandoffReasonWhereAnAgentReadsIt(t *testing.T) {
	for action, flagName := range map[string]string{"create": "--handoff-reason", "update": "--handoff-reason"} {
		help := taskActionHelp[action]
		if !strings.Contains(help, flagName) {
			t.Fatalf("`orbit task %s --help` does not document %s", action, flagName)
		}
	}
	// The create paragraph carries the three facts a caller cannot discover by trying: it needs a
	// project, it grants nothing, and the owner answers.
	create := taskActionHelp["create"]
	section := create[strings.Index(create, "--handoff-reason declares"):]
	for _, want := range []string{"--project-id", "NO authority", "ACCOUNT OWNER", "orbit project"} {
		if !strings.Contains(section, want) {
			t.Fatalf("the --handoff-reason help does not say %q: %q", want, section)
		}
	}
	for _, tool := range []string{"task_create", "task_update"} {
		var spec cliCapabilitySpec
		for _, candidate := range baseCLICapabilities {
			if candidate.Tool == tool {
				spec = candidate
			}
		}
		documented := strings.Join(spec.Arguments, " ")
		for _, want := range []string{"--handoff-reason", "ACCOUNT OWNER", "PROJECT_SCOPE_MISMATCH"} {
			if !strings.Contains(documented, want) {
				t.Fatalf("`orbit capabilities` does not state %q for %s: %q", want, tool, documented)
			}
		}
	}
}
