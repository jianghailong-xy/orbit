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

// A task could be given acceptance criteria when it was created and never again — which is the wrong
// way round, because what proves a task done is usually only clear once somebody has looked at the
// work. So the criteria a task was filed with were the criteria it died with: an agent that found the
// real test had nowhere to put it, and one that found the recorded test was wrong could not take it
// back.
//
// These tests pin the edit door on every path it can travel. The distinction that matters throughout
// is three-way, not two-way: absent means "leave what the task says alone", a string means "these are
// the criteria now" (the empty string included), and null means "this task has none". A field that is
// parsed and dropped before the body, or a null flattened into an omission, reads exactly like a task
// whose criteria were preserved on purpose — so every assertion below is made against the wire.

// captureUpdateBody stands in for PATCH /runner/tasks/<id> and records what was sent. Separate from
// captureCreateBody next door because the method, the path shape and the failure it guards differ:
// on an update, a field missing from the body is not "nothing was said", it is "nothing changed".
func captureUpdateBody(t *testing.T, path string) (*httptest.Server, *[]map[string]interface{}) {
	t.Helper()
	var bodies []map[string]interface{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPatch || r.URL.Path != path {
			t.Errorf("request = %s %s, want PATCH %s", r.Method, r.URL.Path, path)
		}
		var body map[string]interface{}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode body: %v", err)
		}
		bodies = append(bodies, body)
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"id":"task-1"}`))
	}))
	t.Cleanup(srv.Close)
	return srv, &bodies
}

func TestTaskCLIUpdateSendsAcceptanceCriteria(t *testing.T) {
	srv, bodies := captureUpdateBody(t, "/api/runner/tasks/task-1")
	configureCLITestRunner(t, srv.URL)

	var out bytes.Buffer
	err := cmdTaskCLI([]string{
		"update", "task-1",
		"--acceptance-criteria", "`go test ./...` passes and the importer handles an empty file",
		"--json",
	}, strings.NewReader(""), &out)
	if err != nil {
		t.Fatal(err)
	}

	if len(*bodies) != 1 {
		t.Fatalf("requests = %d", len(*bodies))
	}
	body := (*bodies)[0]
	if got := body["acceptanceCriteria"]; got != "`go test ./...` passes and the importer handles an empty file" {
		t.Fatalf("acceptanceCriteria = %#v, body = %#v", got, body)
	}
	// A replacement of one field is not an edit of the others: a body carrying anything the caller
	// did not name would blank whatever it names on a PATCH that only meant to restate the criteria.
	if len(body) != 1 {
		t.Fatalf("update sent fields nobody asked for: %#v", body)
	}
}

// Criteria and description answer different questions, and an update that sets both has to keep them
// apart — criteria written over the description would leave an agent knowing what to prove and not
// what to do.
func TestTaskCLIUpdateSendsAcceptanceCriteriaAlongsideTheDescription(t *testing.T) {
	srv, bodies := captureUpdateBody(t, "/api/runner/tasks/task-1")
	configureCLITestRunner(t, srv.URL)

	var out bytes.Buffer
	err := cmdTaskCLI([]string{
		"update", "task-1",
		"--description", "Rewrite the importer",
		"--acceptance-criteria", "The suite is green",
		"--status", "IN_PROGRESS",
		"--json",
	}, strings.NewReader(""), &out)
	if err != nil {
		t.Fatal(err)
	}

	body := (*bodies)[0]
	if body["description"] != "Rewrite the importer" {
		t.Fatalf("description = %#v, body = %#v", body["description"], body)
	}
	if body["acceptanceCriteria"] != "The suite is green" {
		t.Fatalf("acceptanceCriteria = %#v, body = %#v", body["acceptanceCriteria"], body)
	}
	if body["status"] != "IN_PROGRESS" {
		t.Fatalf("criteria cost the update another field: %#v", body)
	}
}

// Criteria are usually a list, and a list is multiline. Whatever stdin held has to arrive
// byte-for-byte: blank lines, indentation and the trailing newline are the structure of the text, and
// a reader that trimmed or rewrapped them would silently reformat what a human wrote.
func TestTaskCLIUpdateReadsAcceptanceCriteriaFromStdinExactly(t *testing.T) {
	srv, bodies := captureUpdateBody(t, "/api/runner/tasks/task-1")
	configureCLITestRunner(t, srv.URL)

	criteria := "  1. `go vet ./...` is clean\n\n  2. The 404 page renders in Safari\n\t3. No new flags\n"
	var out bytes.Buffer
	err := cmdTaskCLI([]string{"update", "task-1", "--acceptance-criteria-file", "-", "--json"},
		strings.NewReader(criteria), &out)
	if err != nil {
		t.Fatal(err)
	}

	if got := (*bodies)[0]["acceptanceCriteria"]; got != criteria {
		t.Fatalf("acceptanceCriteria = %q, want %q", got, criteria)
	}
}

// Deliberately blank is not the same as unmentioned, and the server agrees: the DTO puts no MinLength
// on the field. So `--acceptance-criteria ""` replaces the criteria with an empty string rather than
// being second-guessed into an omission, which would leave the old criteria in place — the opposite
// of what was typed.
func TestTaskCLIUpdateSendsAnExplicitlyEmptyAcceptanceCriteria(t *testing.T) {
	srv, bodies := captureUpdateBody(t, "/api/runner/tasks/task-1")
	configureCLITestRunner(t, srv.URL)

	var out bytes.Buffer
	if err := cmdTaskCLI([]string{"update", "task-1", "--acceptance-criteria", "", "--json"},
		strings.NewReader(""), &out); err != nil {
		t.Fatal(err)
	}

	got, present := (*bodies)[0]["acceptanceCriteria"]
	if !present {
		t.Fatalf("an explicit empty criteria was dropped instead of sent: %#v", (*bodies)[0])
	}
	if got != "" {
		t.Fatalf("acceptanceCriteria = %#v, want the empty string it was given", got)
	}
}

// The clear path, and the one place a JSON null is load-bearing: the server distinguishes null (drop
// the criteria) from absent (keep them), so a null that arrives as an omission is a clear that
// silently did nothing and reported success. Asserted on the raw bytes, because a decoded map cannot
// tell "key present, value null" from "key present, value the empty string" as clearly as the wire
// can.
func TestTaskCLIUpdateClearsAcceptanceCriteriaWithAnExplicitNull(t *testing.T) {
	var raw []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPatch {
			t.Errorf("method = %s, want PATCH", r.Method)
		}
		raw, _ = io.ReadAll(r.Body)
		_, _ = w.Write([]byte(`{"id":"task-1"}`))
	}))
	defer srv.Close()
	configureCLITestRunner(t, srv.URL)

	var out bytes.Buffer
	if err := cmdTaskCLI([]string{"update", "task-1", "--clear-acceptance-criteria", "--json"},
		strings.NewReader(""), &out); err != nil {
		t.Fatal(err)
	}

	if !strings.Contains(string(raw), `"acceptanceCriteria":null`) {
		t.Fatalf("clear did not send an explicit null: %s", raw)
	}
	var body map[string]interface{}
	if err := json.Unmarshal(raw, &body); err != nil {
		t.Fatal(err)
	}
	value, present := body["acceptanceCriteria"]
	if !present {
		t.Fatalf("clear sent no acceptanceCriteria at all: %s", raw)
	}
	if value != nil {
		t.Fatalf("acceptanceCriteria = %#v, want null", value)
	}
}

// Every update that existed before these flags must send the request it sent before. Absence is the
// only thing that leaves a task's criteria alone, so a status change that volunteered the field —
// blank or otherwise — would rewrite criteria nobody mentioned.
func TestTaskCLIUpdateOmitsAcceptanceCriteriaWhenNotAsked(t *testing.T) {
	srv, bodies := captureUpdateBody(t, "/api/runner/tasks/task-1")
	configureCLITestRunner(t, srv.URL)

	var out bytes.Buffer
	if err := cmdTaskCLI([]string{"update", "task-1", "--status", "DONE", "--json"},
		strings.NewReader(""), &out); err != nil {
		t.Fatal(err)
	}

	if _, present := (*bodies)[0]["acceptanceCriteria"]; present {
		t.Fatalf("acceptanceCriteria sent without the flag: %#v", (*bodies)[0])
	}
}

// The three flags are mutually exclusive instructions about one field: two ways to supply a
// replacement (naming both is unresolvable, not a preference order) and one way to remove it (which
// contradicts either replacement outright). None of them may reach the server as a guess, and none
// may consume stdin on the way to being refused — a partially drained stdin is not something the
// caller can retry from.
func TestTaskCLIUpdateRejectsConflictingAcceptanceCriteriaFlagsBeforeReadingOrSending(t *testing.T) {
	for _, tc := range []struct {
		name  string
		args  []string
		stdin string
		want  string
	}{
		{
			name: "both replacement forms",
			args: []string{"update", "task-1", "--acceptance-criteria", "inline", "--acceptance-criteria-file", "-", "--json"},
			want: "--acceptance-criteria and --acceptance-criteria-file cannot be used together",
		},
		{
			name: "clear and inline replacement",
			args: []string{"update", "task-1", "--clear-acceptance-criteria", "--acceptance-criteria", "inline", "--json"},
			want: "--clear-acceptance-criteria and --acceptance-criteria cannot be used together",
		},
		{
			name: "clear and stdin replacement",
			args: []string{"update", "task-1", "--clear-acceptance-criteria", "--acceptance-criteria-file", "-", "--json"},
			want: "--clear-acceptance-criteria and --acceptance-criteria-file cannot be used together",
		},
		{
			// One stdin, two readers: the first read drains it and the second gets an empty string, so
			// the update would blank the criteria (or the description) and report success.
			name: "description and criteria both from stdin",
			args: []string{"update", "task-1", "--description-file", "-", "--acceptance-criteria-file", "-", "--json"},
			want: "--description-file and --acceptance-criteria-file",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var requests int
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				requests++
				_, _ = w.Write([]byte(`{"id":"task-1"}`))
			}))
			defer srv.Close()
			configureCLITestRunner(t, srv.URL)

			in := &recordingStdin{r: strings.NewReader("text nobody can attribute to a field")}
			var out bytes.Buffer
			err := cmdTaskCLI(tc.args, in, &out)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want %q", err, tc.want)
			}
			if in.read {
				t.Fatal("stdin was consumed before the conflict was noticed")
			}
			if requests != 0 {
				t.Fatalf("requests = %d, want the conflict caught before the round trip", requests)
			}
		})
	}
}

// The file form accepts stdin and nothing else, matching --description-file: a path here would be a
// file read on the runner's disk with the runner's credentials, on behalf of a caller who only ever
// gets to name it.
func TestTaskCLIUpdateRejectsAnAcceptanceCriteriaPath(t *testing.T) {
	configureCLITestRunner(t, "http://127.0.0.1:1")

	var out bytes.Buffer
	err := cmdTaskCLI([]string{"update", "task-1", "--acceptance-criteria-file", "/etc/passwd", "--json"},
		strings.NewReader(""), &out)
	if err == nil || !strings.Contains(err.Error(), "--acceptance-criteria-file accepts only '-'") {
		t.Fatalf("err = %v", err)
	}
}

// The legal shapes of the shared stdin, both directions. Rejecting either would make the stdin form
// unusable for the exact cases it exists for — long criteria beside a one-line description, and a
// long description beside one-line criteria — and the pair is only ambiguous when BOTH come from the
// stream.
func TestTaskCLIUpdateAllowsEitherFieldInlineWithTheOtherOnStdin(t *testing.T) {
	criteria := "The suite is green\nand the binary still starts\n"
	description := "Rewrite the importer,\nthen delete the shim\n"

	for _, tc := range []struct {
		name        string
		args        []string
		stdin       string
		description string
		criteria    string
	}{
		{
			name:        "direct description, criteria on stdin",
			args:        []string{"update", "task-1", "--description", "Fix the importer", "--acceptance-criteria-file", "-", "--json"},
			stdin:       criteria,
			description: "Fix the importer",
			criteria:    criteria,
		},
		{
			name:        "description on stdin, direct criteria",
			args:        []string{"update", "task-1", "--description-file", "-", "--acceptance-criteria", "The suite is green", "--json"},
			stdin:       description,
			description: description,
			criteria:    "The suite is green",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv, bodies := captureUpdateBody(t, "/api/runner/tasks/task-1")
			configureCLITestRunner(t, srv.URL)

			var out bytes.Buffer
			if err := cmdTaskCLI(tc.args, strings.NewReader(tc.stdin), &out); err != nil {
				t.Fatal(err)
			}

			body := (*bodies)[0]
			if body["description"] != tc.description {
				t.Fatalf("description = %#v, want %q", body["description"], tc.description)
			}
			if body["acceptanceCriteria"] != tc.criteria {
				t.Fatalf("acceptanceCriteria = %#v, want %q", body["acceptanceCriteria"], tc.criteria)
			}
		})
	}
}

// MCP carries the same three-way distinction, and its copy list is a separate one from the CLI's — so
// this fails on its own if the field is added to the schema and not to the body. The null case is the
// one a helper that reads strings would quietly turn into an omission.
func TestMCPTaskUpdateSendsReplacementEmptyAndNullAcceptanceCriteria(t *testing.T) {
	for _, tc := range []struct {
		name string
		args map[string]interface{}
		want string
	}{
		{
			name: "replacement",
			args: map[string]interface{}{"taskId": "t1", "acceptanceCriteria": "`go test ./...` passes"},
			want: "\"acceptanceCriteria\":\"`go test ./...` passes\"",
		},
		{
			name: "explicitly empty",
			args: map[string]interface{}{"taskId": "t1", "acceptanceCriteria": ""},
			want: `"acceptanceCriteria":""`,
		},
		{
			name: "cleared",
			args: map[string]interface{}{"taskId": "t1", "acceptanceCriteria": nil},
			want: `"acceptanceCriteria":null`,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var method, path string
			var raw []byte
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				method, path = r.Method, r.URL.Path
				raw, _ = io.ReadAll(r.Body)
				_, _ = w.Write([]byte(`{"id":"t1"}`))
			}))
			defer srv.Close()

			mcp := &mcpServer{agentID: "agent-1", t: NewTransport(srv.URL, "tok")}
			res := mcp.callTool("task_update", tc.args)
			if res["isError"] == true {
				t.Fatalf("task_update returned an error: %#v", res["content"])
			}
			if method != http.MethodPatch || path != "/api/runner/tasks/t1" {
				t.Fatalf("task_update hit %s %s", method, path)
			}
			if !strings.Contains(string(raw), tc.want) {
				t.Fatalf("body = %s, want it to contain %s", raw, tc.want)
			}
		})
	}
}

// The omission half of the same claim: an update of some other field must not volunteer criteria,
// or every status change rewrites what settles the task.
func TestMCPTaskUpdateOmitsAcceptanceCriteriaWhenNotGiven(t *testing.T) {
	var body map[string]interface{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&body)
		_, _ = w.Write([]byte(`{"id":"t1"}`))
	}))
	defer srv.Close()

	mcp := &mcpServer{agentID: "agent-1", t: NewTransport(srv.URL, "tok")}
	res := mcp.callTool("task_update", map[string]interface{}{"taskId": "t1", "status": "DONE"})
	if res["isError"] == true {
		t.Fatalf("task_update returned an error: %#v", res["content"])
	}
	if _, present := body["acceptanceCriteria"]; present {
		t.Fatalf("acceptanceCriteria sent without being given: %#v", body)
	}
	if body["status"] != "DONE" {
		t.Fatalf("status = %#v, body = %#v", body["status"], body)
	}
}

// The schema is what a model reads before it writes anything, so it has to carry the nullability that
// makes clearing expressible, the server's cap, and the two confusions the field invites: restating
// the work instead of what proves it, and copying the project's criteria onto a task under it.
func TestMCPTaskUpdateDeclaresNullableAcceptanceCriteria(t *testing.T) {
	tools := toolDescriptors(false, false)
	props := mcpToolProps(tools, "task_update")

	criteria, ok := props["acceptanceCriteria"].(map[string]interface{})
	if !ok {
		t.Fatalf("task_update has no acceptanceCriteria property: %#v", props["acceptanceCriteria"])
	}
	// Nullable, unlike task_create's: on an update there is an existing value to remove, and a
	// schema saying "string" tells a model the clear it needs is not available.
	types, ok := criteria["type"].([]string)
	if !ok || len(types) != 2 || types[0] != "string" || types[1] != "null" {
		t.Fatalf("acceptanceCriteria type = %#v, want [string null]", criteria["type"])
	}
	if criteria["maxLength"] != maxTaskAcceptanceCriteriaChars {
		t.Fatalf("acceptanceCriteria maxLength = %#v, want %d", criteria["maxLength"], maxTaskAcceptanceCriteriaChars)
	}

	// Optional: an update that changes something else must not have to restate the criteria.
	for _, tool := range tools {
		if tool["name"] != "task_update" {
			continue
		}
		schema, _ := tool["inputSchema"].(map[string]interface{})
		required, _ := schema["required"].([]string)
		for _, field := range required {
			if field == "acceptanceCriteria" {
				t.Fatal("task_update made acceptanceCriteria required")
			}
		}
	}

	text, _ := criteria["description"].(string)
	// The whole lifecycle, because each outcome is a different sentence a caller has to be told:
	// omission preserves, a string replaces, null clears.
	for _, want := range []string{"OMIT", "REPLACE", "CLEAR", "null"} {
		if !strings.Contains(text, want) {
			t.Fatalf("acceptanceCriteria description does not state %q: %q", want, text)
		}
	}
	if !strings.Contains(text, "verifiable") {
		t.Fatalf("acceptanceCriteria does not say the result must be verifiable: %q", text)
	}
	if !strings.Contains(text, "description") {
		t.Fatalf("acceptanceCriteria does not distinguish itself from description: %q", text)
	}
	// A task's criteria are not its project's — the confusion that produces a plausible-looking
	// wrong value, since the project's criteria are readable and copying them looks like diligence.
	if !strings.Contains(text, "project_get") {
		t.Fatalf("acceptanceCriteria does not distinguish itself from the project's own: %q", text)
	}
}

// The tool description is the other half of the same instruction, and it used to tell the caller to
// write acceptance criteria into `description` — advice that now contradicts the field next to it.
func TestMCPTaskUpdateToolTextDefersProofOfDoneToAcceptanceCriteria(t *testing.T) {
	tools := toolDescriptors(true, true)

	props := mcpToolProps(tools, "task_update")
	description, _ := props["description"].(map[string]interface{})
	descriptionText, _ := description["description"].(string)
	if strings.Contains(strings.ToLower(descriptionText), "and acceptance criteria") {
		t.Fatalf("task_update description property still asks for criteria inline: %q", descriptionText)
	}
	if !strings.Contains(descriptionText, "acceptanceCriteria") {
		t.Fatalf("task_update description property does not hand proof-of-done over: %q", descriptionText)
	}
	// Narrowed, not gutted: it still has to ask for the things a prompt is actually for.
	for _, want := range []string{"background", "files involved", "steps"} {
		if !strings.Contains(descriptionText, want) {
			t.Fatalf("task_update description property dropped %q while being narrowed: %q", want, descriptionText)
		}
	}
	// The same copy task_create uses. Two tools that both take the field must not disagree about
	// where proof-of-done belongs.
	createProps := mcpToolProps(tools, "task_create")
	createDescription, _ := createProps["description"].(map[string]interface{})
	if createText, _ := createDescription["description"].(string); createText != descriptionText {
		t.Fatalf("task_create and task_update give different prompt guidance:\n%q\n%q", createText, descriptionText)
	}

	for _, tool := range tools {
		if tool["name"] != "task_update" {
			continue
		}
		text, _ := tool["description"].(string)
		if strings.Contains(text, "steps, acceptance criteria") {
			t.Fatalf("task_update tool description still tells the caller to write criteria into the prompt: %q", text)
		}
		if !strings.Contains(text, "acceptanceCriteria") {
			t.Fatalf("task_update tool description does not mention acceptanceCriteria: %q", text)
		}
		// What the tool text has to add beyond the schema: that this is the door criteria are
		// normally written at, with all three outcomes named.
		for _, want := range []string{"omit", "replace", "clear", "null"} {
			if !strings.Contains(strings.ToLower(text), want) {
				t.Fatalf("task_update tool description does not state %q: %q", want, text)
			}
		}
		if !strings.Contains(text, "project_get") {
			t.Fatalf("task_update tool description does not separate the task's criteria from its project's: %q", text)
		}
		return
	}
	t.Fatal("task_update tool missing")
}

// 4,000 characters is the server's limit, and both doors state it — but a stated limit is advice, and
// the request that ignores it comes back 400. An update reported as applied and never written is the
// outcome a coordinator cannot detect, so the rejection has to surface, with the reason.
func TestTaskUpdateReportsOversizedAcceptanceCriteriaAtBothDoors(t *testing.T) {
	oversizedServer := func(t *testing.T) *httptest.Server {
		t.Helper()
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"statusCode":400,"message":["acceptanceCriteria must be shorter than or equal to 4000 characters"]}`))
		}))
		t.Cleanup(srv.Close)
		return srv
	}
	oversized := strings.Repeat("x", maxTaskAcceptanceCriteriaChars+1)

	t.Run("cli", func(t *testing.T) {
		srv := oversizedServer(t)
		configureCLITestRunner(t, srv.URL)

		var out bytes.Buffer
		err := cmdTaskCLI([]string{"update", "task-1", "--acceptance-criteria-file", "-", "--json"},
			strings.NewReader(oversized), &out)
		if err == nil {
			t.Fatalf("an oversized criteria exited zero, output = %q", out.String())
		}
		if !strings.Contains(err.Error(), "4000 characters") {
			t.Fatalf("err = %v", err)
		}
	})

	t.Run("mcp", func(t *testing.T) {
		srv := oversizedServer(t)

		mcp := &mcpServer{agentID: "agent-1", t: NewTransport(srv.URL, "tok")}
		res := mcp.callTool("task_update", map[string]interface{}{
			"taskId":             "t1",
			"acceptanceCriteria": oversized,
		})
		if res["isError"] != true {
			t.Fatalf("oversized criteria isError = %#v", res["isError"])
		}
		content, _ := res["content"].([]map[string]interface{})
		text, _ := content[0]["text"].(string)
		if !strings.Contains(text, "update task failed") || !strings.Contains(text, "400") {
			t.Fatalf("task_update 400 result = %q", text)
		}
		// The limit itself has to come back, or the model retries with something equally long.
		if !strings.Contains(text, "4000 characters") {
			t.Fatalf("the server's explanation did not reach the caller: %q", text)
		}
	})
}

// `orbit capabilities` is how an agent finds the CLI door and `--help` is how a person does. The
// generic parity tests check that the two agree; this pins what they have to agree about — the flags
// exist, and the things their names cannot carry: the lifecycle, the limit, and which question the
// field answers.
func TestTaskUpdateCapabilitiesAndHelpAdvertiseAcceptanceCriteria(t *testing.T) {
	var spec cliCapabilitySpec
	for _, candidate := range baseCLICapabilities {
		if candidate.Tool == "task_update" {
			spec = candidate
		}
	}
	if spec.Tool == "" {
		t.Fatal("task_update has no CLI capability")
	}

	help := taskActionHelp["update"]
	arguments := strings.Join(spec.Arguments, " ")
	for _, flag := range []string{"--acceptance-criteria", "--acceptance-criteria-file", "--clear-acceptance-criteria"} {
		if !strings.Contains(arguments, flag) {
			t.Fatalf("task_update arguments omit %s: %v", flag, spec.Arguments)
		}
		if !strings.Contains(help, flag) {
			t.Fatalf("`orbit task update --help` does not document %s", flag)
		}
	}

	for label, text := range map[string]string{"help": help, "capability description": spec.Description} {
		// The three-way lifecycle, spelled out: replacing, clearing, and the omission that is the
		// only way to leave existing criteria alone.
		for _, want := range []string{"replace", "clear", "omit"} {
			if !strings.Contains(strings.ToLower(text), want) {
				t.Fatalf("task_update %s does not explain %q: %q", label, want, text)
			}
		}
		if !strings.Contains(text, "4,000") {
			t.Fatalf("task_update %s omits the server's limit: %q", label, text)
		}
		// What the flag is FOR is the part a name cannot carry: both doors have to separate it from
		// --description, or it gets used as a second description.
		if !strings.Contains(text, "--description") {
			t.Fatalf("task_update %s does not distinguish criteria from the description: %q", label, text)
		}
		if !strings.Contains(strings.ToLower(text), "verifiable") {
			t.Fatalf("task_update %s does not say the result must be verifiable: %q", label, text)
		}
		// A task's criteria are not the project's, and the update door is where that gets confused:
		// the project is the thing a coordinator has just been reading.
		if !strings.Contains(strings.ToLower(text), "project") {
			t.Fatalf("task_update %s does not separate the task's criteria from its project's: %q", label, text)
		}
	}

	// The stdin collision is a rule a caller can only learn by being told.
	if !strings.Contains(help, "--description-file") || !strings.Contains(strings.ToLower(help), "cannot be used together") {
		t.Fatalf("`orbit task update --help` does not explain the shared stdin: %q", help)
	}
}
