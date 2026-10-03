package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The reviewer's two answers to a confirmation request, at both doors: the MCP tool (mcp_test.go)
// and the CLI command reach the same route with the task in the path, the reviewing session in the
// header, and the rest of the input as the body (docs/owner-confirmation-review-contract.md §3.5, §8 B1).

type confirmationReviewCall struct {
	method, path, agent, session string
	body                         map[string]interface{}
}

func confirmationReviewServer(t *testing.T) (*httptest.Server, *[]confirmationReviewCall) {
	t.Helper()
	calls := []confirmationReviewCall{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		call := confirmationReviewCall{
			method:  r.Method,
			path:    r.URL.Path,
			agent:   r.Header.Get("X-Orbit-Agent-Id"),
			session: r.Header.Get("X-Orbit-Session-Id"),
		}
		if err := json.NewDecoder(r.Body).Decode(&call.body); err != nil {
			t.Errorf("decode body: %v", err)
		}
		calls = append(calls, call)
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"recordId":"r1","state":"REVIEWED","alreadyRecorded":false}`))
	}))
	t.Cleanup(srv.Close)
	return srv, &calls
}

func TestCLIConfirmationReviewCommandsTakeTheWholeInputAsOneDocument(t *testing.T) {
	for _, usage := range []string{
		"orbit task confirmation-review [task-id] (--input JSON | --input-file -)",
		"orbit task confirmation-return [task-id] (--input JSON | --input-file -)",
	} {
		if !strings.Contains(taskHelp, usage) {
			t.Errorf("group help is missing %q", usage)
		}
	}
	srv, calls := confirmationReviewServer(t)
	configureCLITestRunner(t, srv.URL)
	t.Setenv("ORBIT_TASK_ID", "own-task")
	t.Setenv("ORBIT_SESSION_ID", "reviewer")
	t.Setenv("ORBIT_AGENT_ID", "a1")

	var out bytes.Buffer
	input := `{"taskId":"t9","requestId":"0199a0b1-0000-7000-8000-000000000001","judgment":"ok","needsYou":[]}`
	if err := cmdTaskCLI([]string{"confirmation-review", "--input-file", "-", "--json"}, strings.NewReader(input), &out); err != nil {
		t.Fatal(err)
	}
	if err := cmdTaskCLI([]string{"confirmation-return", "t9", "--input",
		`{"requestId":"0199a0b1-0000-7000-8000-000000000001","reason":"fix it","problems":[{"text":"broken"}]}`,
	}, strings.NewReader(""), &out); err != nil {
		t.Fatal(err)
	}
	// The input's taskId and the argument have to agree, and one of them has to be there: the
	// reviewer's own ORBIT_TASK_ID is never the task under review.
	if err := cmdTaskCLI([]string{"confirmation-review", "t1", "--input", `{"taskId":"t9","requestId":"x","judgment":"ok"}`},
		strings.NewReader(""), &out); err == nil {
		t.Error("a task-id contradicting the input's taskId was accepted")
	}
	if err := cmdTaskCLI([]string{"confirmation-review", "--input", `{"requestId":"x","judgment":"ok"}`},
		strings.NewReader(""), &out); err == nil {
		t.Error("an input naming no task was accepted, presumably for ORBIT_TASK_ID")
	}
	if len(*calls) != 2 {
		t.Fatalf("calls = %#v", *calls)
	}
	if (*calls)[0].path != "/api/runner/tasks/t9/owner-confirmation/review" || (*calls)[1].path != "/api/runner/tasks/t9/owner-confirmation/return" {
		t.Errorf("paths = %q, %q", (*calls)[0].path, (*calls)[1].path)
	}
	for i, call := range *calls {
		if call.session != "reviewer" || call.agent != "a1" {
			t.Errorf("call %d attribution = agent %q, session %q", i, call.agent, call.session)
		}
		if _, ok := call.body["taskId"]; ok {
			t.Errorf("call %d carried taskId in the body: %#v", i, call.body)
		}
	}
	if _, ok := (*calls)[0].body["needsYou"]; !ok {
		t.Errorf("the review's lists were not sent as written: %#v", (*calls)[0].body)
	}
}
