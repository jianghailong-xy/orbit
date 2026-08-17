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

// A coordinator could say what work to do (description) and where it belongs (projectId,
// parentTaskId), but never what would prove the work is finished. The server has stored a task's
// acceptanceCriteria all along — CreateTaskDto accepts it and task_list already reports it — so the
// only thing missing was a door: neither `orbit task create` nor task_create would send the field,
// which reads exactly like a task that has no criteria rather than one whose criteria were dropped.
//
// These tests pin the field to the wire on every path it can travel, because "parsed" and "sent"
// are different claims: a flag that is read into a variable and never reaches the body is invisible
// to anything that only inspects the command line.

// recordingStdin records whether anything read from it, so a test can assert that a rejection happened
// BEFORE the stream was touched — not merely that it happened.
type recordingStdin struct {
	r    io.Reader
	read bool
}

func (s *recordingStdin) Read(p []byte) (int, error) {
	s.read = true
	return s.r.Read(p)
}

func TestTaskCLICreateSendsAcceptanceCriteria(t *testing.T) {
	srv, bodies := captureCreateBody(t, "/api/runner/tasks")
	configureCLITestRunner(t, srv.URL)

	var out bytes.Buffer
	err := cmdTaskCLI([]string{
		"create", "--title", "Ship it",
		"--description", "Rewrite the importer",
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
	// The two fields answer different questions and must both survive: criteria that replaced the
	// description would leave an agent knowing what to prove and not what to do.
	if body["description"] != "Rewrite the importer" {
		t.Fatalf("description = %#v, body = %#v", body["description"], body)
	}
	if body["title"] != "Ship it" {
		t.Fatalf("body lost a field: %#v", body)
	}
}

// Criteria are usually a list, and a list is multiline. Whatever stdin held has to arrive
// byte-for-byte: blank lines, indentation and the trailing newline are the structure of the text,
// and a reader that trimmed or rewrapped them would silently reformat what a human wrote.
func TestTaskCLICreateReadsAcceptanceCriteriaFromStdinExactly(t *testing.T) {
	srv, bodies := captureCreateBody(t, "/api/runner/tasks")
	configureCLITestRunner(t, srv.URL)

	criteria := "  1. `go vet ./...` is clean\n\n  2. The 404 page renders in Safari\n\t3. No new flags\n"
	var out bytes.Buffer
	err := cmdTaskCLI([]string{"create", "--title", "Ship it", "--acceptance-criteria-file", "-", "--json"},
		strings.NewReader(criteria), &out)
	if err != nil {
		t.Fatal(err)
	}

	if got := (*bodies)[0]["acceptanceCriteria"]; got != criteria {
		t.Fatalf("acceptanceCriteria = %q, want %q", got, criteria)
	}
}

// Every create that existed before this flag must send the request it sent before. An empty string
// in the body is a statement ("this task's criteria are blank"); absence is the truth for a caller
// who never mentioned the field, and only absence leaves an existing default alone.
func TestTaskCLICreateOmitsAcceptanceCriteriaWhenNotAsked(t *testing.T) {
	srv, bodies := captureCreateBody(t, "/api/runner/tasks")
	configureCLITestRunner(t, srv.URL)

	var out bytes.Buffer
	if err := cmdTaskCLI([]string{"create", "--title", "Ship it", "--description", "Do the thing", "--json"},
		strings.NewReader(""), &out); err != nil {
		t.Fatal(err)
	}

	if _, present := (*bodies)[0]["acceptanceCriteria"]; present {
		t.Fatalf("acceptanceCriteria sent without the flag: %#v", (*bodies)[0])
	}
}

// Deliberately blank is not the same as unmentioned, and the server agrees: CreateTaskDto puts no
// MinLength on the field. So `--acceptance-criteria ""` goes through as an empty string rather than
// being second-guessed into an omission — unlike the id flags, where blank can only be a typo.
func TestTaskCLICreateSendsAnExplicitlyEmptyAcceptanceCriteria(t *testing.T) {
	srv, bodies := captureCreateBody(t, "/api/runner/tasks")
	configureCLITestRunner(t, srv.URL)

	var out bytes.Buffer
	if err := cmdTaskCLI([]string{"create", "--title", "Ship it", "--acceptance-criteria", "", "--json"},
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

// One field, two ways to supply it: naming both is an unresolvable instruction, not a preference
// order, and guessing one would write whichever the implementation happened to read second.
func TestTaskCLICreateRejectsBothAcceptanceCriteriaForms(t *testing.T) {
	var requests int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests++
		_, _ = w.Write([]byte(`{"id":"created-task"}`))
	}))
	defer srv.Close()
	configureCLITestRunner(t, srv.URL)

	var out bytes.Buffer
	err := cmdTaskCLI([]string{
		"create", "--title", "Ship it",
		"--acceptance-criteria", "inline",
		"--acceptance-criteria-file", "-",
		"--json",
	}, strings.NewReader("from stdin"), &out)
	if err == nil || !strings.Contains(err.Error(), "--acceptance-criteria and --acceptance-criteria-file cannot be used together") {
		t.Fatalf("err = %v", err)
	}
	if requests != 0 {
		t.Fatalf("requests = %d, want the conflict caught before the round trip", requests)
	}
}

// The file form accepts stdin and nothing else, matching --description-file: a path here would be a
// file read on the runner's disk with the runner's credentials, on behalf of a caller who only ever
// gets to name it.
func TestTaskCLICreateRejectsAnAcceptanceCriteriaPath(t *testing.T) {
	configureCLITestRunner(t, "http://127.0.0.1:1")

	var out bytes.Buffer
	err := cmdTaskCLI([]string{"create", "--title", "Ship it", "--acceptance-criteria-file", "/etc/passwd", "--json"},
		strings.NewReader(""), &out)
	if err == nil || !strings.Contains(err.Error(), "--acceptance-criteria-file accepts only '-'") {
		t.Fatalf("err = %v", err)
	}
}

// There is one stdin. Both file flags together cannot mean anything: the first read drains the
// stream and the second gets an empty string, so the create would file blank criteria (or a blank
// description) and report success. It has to be refused before either read — a partially consumed
// stdin is not something the caller can retry from — and before any request.
func TestTaskCLICreateRejectsTwoStdinReadersBeforeReadingOrSending(t *testing.T) {
	var requests int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests++
		_, _ = w.Write([]byte(`{"id":"created-task"}`))
	}))
	defer srv.Close()
	configureCLITestRunner(t, srv.URL)

	in := &recordingStdin{r: strings.NewReader("some text nobody can attribute to a field")}
	var out bytes.Buffer
	err := cmdTaskCLI([]string{
		"create", "--title", "Ship it",
		"--description-file", "-",
		"--acceptance-criteria-file", "-",
		"--json",
	}, in, &out)
	if err == nil || !strings.Contains(err.Error(), "--description-file and --acceptance-criteria-file") {
		t.Fatalf("err = %v", err)
	}
	if in.read {
		t.Fatal("stdin was consumed before the conflict was noticed")
	}
	if requests != 0 {
		t.Fatalf("requests = %d, want the conflict caught before the round trip", requests)
	}
}

// The legal shape of the same pair: one field inline, the other on stdin. Nothing is ambiguous
// about it, and rejecting it would make the stdin form unusable for the exact case it exists for —
// long criteria alongside a one-line description.
func TestTaskCLICreateAllowsADirectDescriptionWithCriteriaOnStdin(t *testing.T) {
	srv, bodies := captureCreateBody(t, "/api/runner/tasks")
	configureCLITestRunner(t, srv.URL)

	criteria := "The suite is green\nand the binary still starts\n"
	var out bytes.Buffer
	err := cmdTaskCLI([]string{
		"create", "--title", "Ship it",
		"--description", "Fix the importer",
		"--acceptance-criteria-file", "-",
		"--json",
	}, strings.NewReader(criteria), &out)
	if err != nil {
		t.Fatal(err)
	}

	body := (*bodies)[0]
	if body["description"] != "Fix the importer" {
		t.Fatalf("description = %#v, body = %#v", body["description"], body)
	}
	if body["acceptanceCriteria"] != criteria {
		t.Fatalf("acceptanceCriteria = %#v, want %q", body["acceptanceCriteria"], criteria)
	}
}

// Adding the field is only half the job: the create path used to tell callers to put acceptance
// criteria INSIDE the description, and leaving that in place next to acceptanceCriteria is an
// instruction to write the same thing twice. Two copies drift, and nothing then says which one
// settles the task — so the description copy has to hand the job over rather than compete for it.
//
// The same sentence is shared with task_update and session_create, neither of which takes the new
// field: for them the prompt IS the only place criteria can live, so this pins that the create copy
// was split off and the others were left exactly as they were.
func TestMCPTaskCreateDescriptionDefersProofOfDoneToAcceptanceCriteria(t *testing.T) {
	tools := toolDescriptors(true, true)

	// The wording task_update still uses, pinned literally: a "fix" that edited the shared string in
	// place would satisfy every check below except this one.
	const sharedPromptDesc = "Write this as a self-contained, executable prompt for the task — background, files involved, concrete steps, and acceptance criteria — so an agent with no prior conversation context can pick it up and act on it directly."

	batch := mcpToolProps(tools, "task_create_batch")
	tasks, _ := batch["tasks"].(map[string]interface{})
	items, _ := tasks["items"].(map[string]interface{})
	itemProps, _ := items["properties"].(map[string]interface{})

	for label, props := range map[string]map[string]interface{}{
		"task_create": mcpToolProps(tools, "task_create"), "task_create_batch item": itemProps,
	} {
		description, _ := props["description"].(map[string]interface{})
		text, _ := description["description"].(string)
		if text == sharedPromptDesc {
			t.Fatalf("%s description still shares task_update's prompt copy, which asks for criteria inline", label)
		}
		if strings.Contains(strings.ToLower(text), "and acceptance criteria") {
			t.Fatalf("%s description still asks for acceptance criteria inline: %q", label, text)
		}
		// Not merely silent about them — it has to name where they go, or a caller who was being
		// told to include them now gets told nothing and keeps the habit.
		if !strings.Contains(text, "acceptanceCriteria") {
			t.Fatalf("%s description does not hand proof-of-done to acceptanceCriteria: %q", label, text)
		}
		// And it still has to ask for the things it is actually for.
		for _, want := range []string{"background", "files involved", "steps"} {
			if !strings.Contains(text, want) {
				t.Fatalf("%s description dropped %q while being narrowed: %q", label, want, text)
			}
		}
	}

	// The tool description carried the same list, so it contradicted the schema in the same way.
	for _, name := range []string{"task_create", "task_create_batch"} {
		for _, tool := range tools {
			if tool["name"] != name {
				continue
			}
			text, _ := tool["description"].(string)
			if strings.Contains(text, "steps, acceptance criteria") {
				t.Fatalf("%s description still tells the caller to write criteria into the prompt: %q", name, text)
			}
		}
	}

	// task_update takes no acceptanceCriteria, so for it the prompt genuinely is the only place the
	// criteria can live: both halves of its copy must be exactly what they were.
	updateProps := mcpToolProps(tools, "task_update")
	updateDescription, _ := updateProps["description"].(map[string]interface{})
	if text, _ := updateDescription["description"].(string); text != sharedPromptDesc {
		t.Fatalf("task_update description property changed: %q", text)
	}
	for _, tool := range tools {
		if tool["name"] != "task_update" {
			continue
		}
		text, _ := tool["description"].(string)
		if !strings.Contains(text, "(background, files involved, steps, acceptance criteria)") {
			t.Fatalf("task_update tool description changed: %q", text)
		}
	}
}

// The field is declared once and shared, so it has to appear on both doors: a schema carrying it on
// task_create alone leaves the tool that files a whole plan unable to say what settles any of it.
func TestMCPTaskCreateTakesAcceptanceCriteriaOnSingleAndBatchItems(t *testing.T) {
	tools := toolDescriptors(false, false)

	single := mcpToolProps(tools, "task_create")
	batch := mcpToolProps(tools, "task_create_batch")
	tasks, _ := batch["tasks"].(map[string]interface{})
	items, _ := tasks["items"].(map[string]interface{})
	itemProps, _ := items["properties"].(map[string]interface{})

	for label, props := range map[string]map[string]interface{}{
		"task_create": single, "task_create_batch item": itemProps,
	} {
		criteria, _ := props["acceptanceCriteria"].(map[string]interface{})
		if criteria["type"] != "string" {
			t.Fatalf("%s acceptanceCriteria schema = %#v", label, props["acceptanceCriteria"])
		}
		// The server's own cap, stated where a model can see it: a plan that would be rejected at
		// 4,001 characters is worth catching while it is still being written.
		if criteria["maxLength"] != maxTaskAcceptanceCriteriaChars {
			t.Fatalf("%s acceptanceCriteria maxLength = %#v, want %d",
				label, criteria["maxLength"], maxTaskAcceptanceCriteriaChars)
		}
	}
	if maxTaskAcceptanceCriteriaChars != 4000 {
		t.Fatalf("maxTaskAcceptanceCriteriaChars = %d, want the server's 4000", maxTaskAcceptanceCriteriaChars)
	}

	// Optional on both: a task with nothing worth stating is still an ordinary task.
	for _, name := range []string{"task_create", "task_create_batch"} {
		for _, tool := range tools {
			if tool["name"] != name {
				continue
			}
			schema, _ := tool["inputSchema"].(map[string]interface{})
			required, _ := schema["required"].([]string)
			for _, field := range required {
				if field == "acceptanceCriteria" {
					t.Fatalf("%s made acceptanceCriteria required", name)
				}
			}
			description, _ := tool["description"].(string)
			if !strings.Contains(description, "acceptanceCriteria") {
				t.Fatalf("%s description does not mention acceptanceCriteria: %q", name, description)
			}
		}
	}

	// The two confusions this field invites, both of which produce a plausible-looking wrong value:
	// restating the work instead of what proves it, and copying the project's criteria onto every
	// task under it. The schema has to separate itself from both.
	criteria, _ := single["acceptanceCriteria"].(map[string]interface{})
	criteriaDesc, _ := criteria["description"].(string)
	if !strings.Contains(criteriaDesc, "description") {
		t.Fatalf("acceptanceCriteria does not distinguish itself from description: %q", criteriaDesc)
	}
	if !strings.Contains(criteriaDesc, "project_get") {
		t.Fatalf("acceptanceCriteria does not distinguish itself from the project's own: %q", criteriaDesc)
	}
	if !strings.Contains(criteriaDesc, "verifiable") {
		t.Fatalf("acceptanceCriteria does not say the result must be verifiable: %q", criteriaDesc)
	}
	// It travels with the placement fields rather than instead of them.
	if !strings.Contains(criteriaDesc, "projectId") || !strings.Contains(criteriaDesc, "parentTaskId") {
		t.Fatalf("acceptanceCriteria does not say it coexists with projectId/parentTaskId: %q", criteriaDesc)
	}
}

func TestMCPTaskCreateSendsAcceptanceCriteriaToTheServer(t *testing.T) {
	srv, bodies := captureCreateBody(t, "/api/runner/tasks")

	mcp := &mcpServer{agentID: "agent-1", sessionID: "sess-1", t: NewTransport(srv.URL, "tok")}
	res := mcp.callTool("task_create", map[string]interface{}{
		"title":              "Ship it",
		"description":        "Rewrite the importer",
		"projectId":          "proj-1",
		"parentTaskId":       "task-parent",
		"acceptanceCriteria": "`go test ./...` passes",
	})
	if res["isError"] == true {
		t.Fatalf("task_create returned an error: %#v", res["content"])
	}

	body := (*bodies)[0]
	if body["acceptanceCriteria"] != "`go test ./...` passes" {
		t.Fatalf("acceptanceCriteria = %#v, body = %#v", body["acceptanceCriteria"], body)
	}
	// Coexistence is the claim the schema makes, so it is asserted rather than assumed: criteria
	// that displaced the placement fields would file a well-described task in the wrong place.
	if body["projectId"] != "proj-1" || body["parentTaskId"] != "task-parent" {
		t.Fatalf("criteria cost the task its placement: %#v", body)
	}
	if body["description"] != "Rewrite the importer" {
		t.Fatalf("description = %#v, body = %#v", body["description"], body)
	}
}

// The batch copies its fields through a second, separate list from the single form — so it is the
// one that silently drops a field task_create carries, and this test fails on its own if that list
// is left alone. It runs the full approval path, where the body is built for the preview, shown on
// the card, and written afterwards: criteria that reach only the write leave a human approving a
// batch whose stated tests they never saw.
func TestMCPTaskCreateBatchSendsEveryItemsAcceptanceCriteria(t *testing.T) {
	var previewBody, approvalBody, createBody map[string]interface{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/tasks/batch-preview"):
			_ = json.NewDecoder(r.Body).Decode(&previewBody)
			_, _ = w.Write([]byte(`{"taskCount":2,"startingNow":1}`))
		case strings.HasSuffix(r.URL.Path, "/approvals"):
			_ = json.NewDecoder(r.Body).Decode(&approvalBody)
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
			map[string]interface{}{
				"title": "Build", "ref": "s0",
				"acceptanceCriteria": "The binary builds on arm64",
			},
			map[string]interface{}{
				"title": "Deploy", "dependsOnRefs": []interface{}{"s0"},
				"acceptanceCriteria": "/healthz answers 200 from the deployed host",
			},
		},
	})
	if res["isError"] == true {
		t.Fatalf("task_create_batch returned an error: %#v", res["content"])
	}

	// Every stage, not just the last: the card is where the decision is made.
	stages := map[string]map[string]interface{}{
		"preview": previewBody, "approval": approvalBody, "create": createBody,
	}
	for label, body := range stages {
		if label == "approval" {
			// The approval wraps the same items one level down, under the tool call's input.
			input, _ := body["input"].(map[string]interface{})
			body = input
		}
		sent, _ := body["tasks"].([]interface{})
		if len(sent) != 2 {
			t.Fatalf("%s body = %#v, want two tasks", label, body)
		}
		// Per item, and not the same value twice: hoisting the first item's criteria batch-wide
		// would claim every task is settled by whatever settles the first one.
		first, _ := sent[0].(map[string]interface{})
		second, _ := sent[1].(map[string]interface{})
		if first["acceptanceCriteria"] != "The binary builds on arm64" {
			t.Fatalf("%s tasks[0] acceptanceCriteria = %#v", label, first["acceptanceCriteria"])
		}
		if second["acceptanceCriteria"] != "/healthz answers 200 from the deployed host" {
			t.Fatalf("%s tasks[1] acceptanceCriteria = %#v", label, second["acceptanceCriteria"])
		}
		// The batch's own wiring is untouched by the new field.
		if first["ref"] != "s0" {
			t.Fatalf("%s tasks[0] ref = %#v", label, first["ref"])
		}
		if refs, _ := second["dependsOnRefs"].([]interface{}); len(refs) != 1 || refs[0] != "s0" {
			t.Fatalf("%s tasks[1] dependsOnRefs = %#v", label, second["dependsOnRefs"])
		}
	}
}

// A batch mixes tasks that state criteria with tasks that do not, and the ones that do not must
// arrive without the field rather than with a blank or a neighbour's. Runs the ungated path
// (startingNow 0) so the copy is exercised independently of the approval one above.
func TestMCPTaskCreateBatchLeavesAnItemWithoutCriteriaAlone(t *testing.T) {
	var createBody map[string]interface{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/tasks/batch-preview"):
			_, _ = w.Write([]byte(`{"taskCount":2,"startingNow":0}`))
		default:
			_ = json.NewDecoder(r.Body).Decode(&createBody)
			_, _ = w.Write([]byte(`[{"id":"t1"},{"id":"t2"}]`))
		}
	}))
	defer srv.Close()

	mcp := &mcpServer{agentID: "agent-1", sessionID: "sess-1", t: NewTransport(srv.URL, "tok")}
	res := mcp.callTool("task_create_batch", map[string]interface{}{
		"tasks": []interface{}{
			map[string]interface{}{"title": "Measured", "acceptanceCriteria": "p99 under 200ms"},
			map[string]interface{}{"title": "Just do it"},
		},
	})
	if res["isError"] == true {
		t.Fatalf("task_create_batch returned an error: %#v", res["content"])
	}

	sent, _ := createBody["tasks"].([]interface{})
	if len(sent) != 2 {
		t.Fatalf("create body = %#v", createBody)
	}
	first, _ := sent[0].(map[string]interface{})
	second, _ := sent[1].(map[string]interface{})
	if first["acceptanceCriteria"] != "p99 under 200ms" {
		t.Fatalf("tasks[0] acceptanceCriteria = %#v", first["acceptanceCriteria"])
	}
	if _, present := second["acceptanceCriteria"]; present {
		t.Fatalf("an item with no criteria inherited some from its neighbour: %#v", second)
	}
}

// 4,000 characters is the server's limit, and the schema states it — but a schema is advice, and
// the request that ignores it comes back 400. That has to surface as an error at both doors: a task
// reported as created and never written is the outcome a coordinator cannot detect.
func TestMCPTaskCreateReportsOversizedAcceptanceCriteria(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"statusCode":400,"message":["acceptanceCriteria must be shorter than or equal to 4000 characters"]}`))
	}))
	defer srv.Close()

	mcp := &mcpServer{agentID: "agent-1", t: NewTransport(srv.URL, "tok")}
	res := mcp.callTool("task_create", map[string]interface{}{
		"title":              "Ship it",
		"acceptanceCriteria": strings.Repeat("x", maxTaskAcceptanceCriteriaChars+1),
	})
	if res["isError"] != true {
		t.Fatalf("oversized criteria isError = %#v", res["isError"])
	}
	content, _ := res["content"].([]map[string]interface{})
	text, _ := content[0]["text"].(string)
	if !strings.Contains(text, "create task failed") || !strings.Contains(text, "400") {
		t.Fatalf("task_create 400 result = %q", text)
	}
	// The limit itself has to come back, or the model retries with something equally long.
	if !strings.Contains(text, "4000 characters") {
		t.Fatalf("the server's explanation did not reach the caller: %q", text)
	}
}

func TestTaskCLICreateReportsOversizedAcceptanceCriteria(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"statusCode":400,"message":["acceptanceCriteria must be shorter than or equal to 4000 characters"]}`))
	}))
	defer srv.Close()
	configureCLITestRunner(t, srv.URL)

	var out bytes.Buffer
	err := cmdTaskCLI([]string{"create", "--title", "Ship it", "--acceptance-criteria-file", "-", "--json"},
		strings.NewReader(strings.Repeat("x", maxTaskAcceptanceCriteriaChars+1)), &out)
	if err == nil {
		t.Fatalf("an oversized criteria exited zero, output = %q", out.String())
	}
	if !strings.Contains(err.Error(), "4000 characters") {
		t.Fatalf("err = %v", err)
	}
}

// `orbit capabilities` is how an agent finds the CLI door and `--help` is how a person does. The
// generic parity tests check that the two agree; this pins what they have to agree about — the
// flags exist, and the one thing that is not obvious from their names: which question the field
// answers, and how long it may be.
func TestTaskCreateCapabilitiesAndHelpAdvertiseAcceptanceCriteria(t *testing.T) {
	var spec cliCapabilitySpec
	for _, candidate := range baseCLICapabilities {
		if candidate.Tool == "task_create" {
			spec = candidate
		}
	}
	if spec.Tool == "" {
		t.Fatal("task_create has no CLI capability")
	}
	arguments := strings.Join(spec.Arguments, " ")
	for _, flag := range []string{"--acceptance-criteria", "--acceptance-criteria-file"} {
		if !strings.Contains(arguments, flag) {
			t.Fatalf("task_create arguments omit %s: %v", flag, spec.Arguments)
		}
	}
	if !strings.Contains(spec.Description, "--acceptance-criteria") {
		t.Fatalf("task_create description does not explain the flag: %q", spec.Description)
	}
	if !strings.Contains(spec.Description, "4,000") {
		t.Fatalf("task_create description omits the server's limit: %q", spec.Description)
	}

	help := taskActionHelp["create"]
	for _, flag := range []string{"--acceptance-criteria", "--acceptance-criteria-file"} {
		if !strings.Contains(help, flag) {
			t.Fatalf("`orbit task create --help` does not document %s", flag)
		}
	}
	if !strings.Contains(help, "4,000") {
		t.Fatalf("`orbit task create --help` omits the server's limit: %q", help)
	}
	// What the flag is FOR is the part a name cannot carry: both doors have to separate it from
	// --description, or it gets used as a second description.
	for label, text := range map[string]string{"help": help, "capability description": spec.Description} {
		if !strings.Contains(text, "--description") {
			t.Fatalf("task_create %s does not distinguish criteria from the description: %q", label, text)
		}
		if !strings.Contains(strings.ToLower(text), "verifiable") {
			t.Fatalf("task_create %s does not say the result must be verifiable: %q", label, text)
		}
	}
	// The stdin collision is a rule a caller can only learn by being told.
	if !strings.Contains(help, "--description-file") || !strings.Contains(strings.ToLower(help), "cannot be used together") {
		t.Fatalf("`orbit task create --help` does not explain the shared stdin: %q", help)
	}

	// The batch command takes the same item fields, and its help is the only place that says so.
	batchHelp := taskActionHelp["create-batch"]
	if !strings.Contains(batchHelp, "acceptanceCriteria") {
		t.Fatalf("`orbit task create-batch --help` does not list acceptanceCriteria among the item fields")
	}
	if !strings.Contains(batchHelp, "4,000") {
		t.Fatalf("create-batch help omits the server's limit: %q", batchHelp)
	}
}
