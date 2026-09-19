package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Reopening is a status write PLUS the clearing of a retirement, and the second half is the one that
// cannot be guessed: `task_update {status: OPEN}` is refused on a SUPERSEDED or ABANDONED row unless
// the same request names both retirement fields, and those rows are exactly the ones a person is
// picking back up. So the body is asserted key by key, including the two NULLS — a copy helper that
// dropped nil values would produce a request that looks right, clears nothing, and is refused.
//
// Both doors are run against one capture server and the BYTES are compared, because "one write, two
// doors" is a claim about the wire: two spellings that agree today is the drift this door exists to
// prevent.
func TestTaskReopenSendsTheSameOneWriteFromBothDoors(t *testing.T) {
	if !hasMCPTool(toolDescriptors(false, false), "task_reopen") {
		t.Fatalf("task_reopen missing from the base task tools")
	}

	var methods, paths []string
	var raws [][]byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		methods = append(methods, r.Method)
		paths = append(paths, r.URL.Path)
		var buf bytes.Buffer
		if _, err := buf.ReadFrom(r.Body); err != nil {
			t.Error(err)
		}
		raws = append(raws, buf.Bytes())
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"id":"task-1","status":"OPEN"}`))
	}))
	defer srv.Close()

	mcp := &mcpServer{t: NewTransport(srv.URL, "tok")}
	if res := mcp.callTool("task_reopen", map[string]interface{}{"taskId": "task-1"}); res["isError"] == true {
		t.Fatalf("task_reopen returned an error: %#v", res["content"])
	}

	configureCLITestRunner(t, srv.URL)
	var out bytes.Buffer
	if err := cmdTaskCLI([]string{"reopen", "task-1", "--json"}, strings.NewReader(""), &out); err != nil {
		t.Fatal(err)
	}

	if len(raws) != 2 {
		t.Fatalf("requests = %d, want one per door", len(raws))
	}
	for i := range raws {
		if methods[i] != http.MethodPatch || paths[i] != "/api/runner/tasks/task-1" {
			t.Fatalf("door %d hit %s %s", i, methods[i], paths[i])
		}
	}
	if string(raws[0]) != string(raws[1]) {
		t.Fatalf("the two doors spell the write differently:\n%s\n%s", raws[0], raws[1])
	}

	var body map[string]interface{}
	if err := json.Unmarshal(raws[0], &body); err != nil {
		t.Fatal(err)
	}
	if len(body) != 3 {
		t.Fatalf("the write carries more than the transition: %#v", body)
	}
	if body["status"] != "OPEN" {
		t.Fatalf("status = %#v", body["status"])
	}
	// Present AND null. `json.Unmarshal` into a map cannot tell "absent" from "null" by value, which
	// is why the key is looked for in the raw bytes: an omitted retirement is the write that gets
	// refused on exactly the rows this door is for.
	for _, key := range []string{`"supersededByTaskId":null`, `"terminalReason":null`} {
		if !strings.Contains(string(raws[0]), key) {
			t.Fatalf("body = %s, want it to carry %s", raws[0], key)
		}
	}
}

// The refusals stay the server's. A verification task holding a verdict cannot be given another
// status without revoking it in the same request, and the door's job is to hand that sentence back
// with its code and its next step intact rather than to paraphrase it or to revoke anything itself.
func TestTaskReopenPassesTheServersRefusalThroughVerbatim(t *testing.T) {
	const refusal = `{"code":"VERIFIER_STATUS_DERIVED_FROM_VERDICT",` +
		`"requiredAction":"REVOKE_THE_VERDICT_OR_OMIT_STATUS",` +
		`"message":"A verification task with PASS, FAIL or INCONCLUSIVE is DONE because its checking activity has concluded."}`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(refusal))
	}))
	defer srv.Close()

	mcp := &mcpServer{t: NewTransport(srv.URL, "tok")}
	res := mcp.callTool("task_reopen", map[string]interface{}{"taskId": "task-1"})
	if res["isError"] != true {
		t.Fatalf("a refusal came back as success: %#v", res["content"])
	}
	content, _ := res["content"].([]map[string]interface{})
	text, _ := content[0]["text"].(string)
	for _, want := range []string{
		"reopen task failed",
		"  refused: VERIFIER_STATUS_DERIVED_FROM_VERDICT",
		"  do:      REVOKE_THE_VERDICT_OR_OMIT_STATUS",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("task_reopen refusal does not carry %q: %q", want, text)
		}
	}

	configureCLITestRunner(t, srv.URL)
	var out bytes.Buffer
	err := cmdTaskCLI([]string{"reopen", "task-1", "--json"}, strings.NewReader(""), &out)
	if err == nil {
		t.Fatal("orbit task reopen reported a 400 as success")
	}
	for _, want := range []string{
		"reopen task:",
		"  refused: VERIFIER_STATUS_DERIVED_FROM_VERDICT",
		"  do:      REVOKE_THE_VERDICT_OR_OMIT_STATUS",
	} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("orbit task reopen refusal does not carry %q: %q", want, err.Error())
		}
	}
}

// No id and no ORBIT_TASK_ID is a typo, not a request: it is refused before the round trip, with the
// same sentence every other task command answers with.
func TestTaskCLIReopenWithoutATaskIDIsRefusedLocally(t *testing.T) {
	hit := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hit = true
		_, _ = w.Write([]byte(`{}`))
	}))
	defer srv.Close()
	configureCLITestRunner(t, srv.URL)
	t.Setenv("ORBIT_TASK_ID", "")

	var out bytes.Buffer
	err := cmdTaskCLI([]string{"reopen", "--json"}, strings.NewReader(""), &out)
	if err == nil || !strings.Contains(err.Error(), "task id is required") {
		t.Fatalf("orbit task reopen without an id = %v", err)
	}
	if hit {
		t.Fatal("a request went out for a task nobody named")
	}
}
