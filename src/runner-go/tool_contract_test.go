package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"sort"
	"strings"
	"sync"
	"testing"
)

// The agent contract's input and receipt clauses (docs/orbit-agent-contract.md §5.3 and §6), held
// on the path a real engine takes: a JSON-RPC tools/call into `orbit mcp`, decoded from the bytes
// it would have sent. Every case pins what reached the fake control plane as well as what came back,
// because "refused before any write" is a claim about the wire, not about the text.
//
//   - strict input: an unknown field, a wrong type, a missing required field and a mutually
//     exclusive pair are refused with INVALID_ARGUMENTS, naming the field, and no request is made;
//   - the receipt: the creates and updates of tasks, projects, task lists, sessions and agents
//     answer with one document whose id is the entity's — no prose to parse;
//   - refusal, decline, timeout, duplicate submission and non-idempotent retry each have the
//     outcome, the error code and the retry rule the contract states.

// contractServer is a fake control plane that records every request, answers approvals with
// decision, and every other request with respond's answer.
type contractServer struct {
	mu       sync.Mutex
	requests []contractRequest
	decision string
	respond  func(r *http.Request, body map[string]interface{}) (int, string)
}

type contractRequest struct {
	Method string
	Path   string
	Body   map[string]interface{}
}

func newContractServer(t *testing.T, decision string, respond func(r *http.Request, body map[string]interface{}) (int, string)) (*contractServer, *httptest.Server) {
	t.Helper()
	cs := &contractServer{decision: decision, respond: respond}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]interface{}
		_ = json.NewDecoder(r.Body).Decode(&body)
		cs.mu.Lock()
		cs.requests = append(cs.requests, contractRequest{Method: r.Method, Path: r.URL.Path, Body: body})
		cs.mu.Unlock()
		switch {
		case strings.Contains(r.URL.Path, "/approvals/"):
			_, _ = w.Write([]byte(cs.decision))
			return
		case strings.HasSuffix(r.URL.Path, "/approvals"):
			_, _ = w.Write([]byte(`{"id":"ap1","status":"PENDING"}`))
			return
		}
		status, answer := cs.respond(r, body)
		if status == 0 {
			// A request answered with nothing: the connection is dropped after it was received.
			hijacker, ok := w.(http.Hijacker)
			if !ok {
				t.Fatal("the test server cannot drop a connection")
			}
			conn, _, err := hijacker.Hijack()
			if err == nil {
				_ = conn.Close()
			}
			return
		}
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(answer))
	}))
	t.Cleanup(srv.Close)
	return cs, srv
}

// writes are the requests that were not approvals: what the call actually tried to change or read.
func (cs *contractServer) writes() []contractRequest {
	cs.mu.Lock()
	defer cs.mu.Unlock()
	var out []contractRequest
	for _, r := range cs.requests {
		if !strings.Contains(r.Path, "/approvals") {
			out = append(out, r)
		}
	}
	return out
}

func (cs *contractServer) all() []contractRequest {
	cs.mu.Lock()
	defer cs.mu.Unlock()
	return append([]contractRequest(nil), cs.requests...)
}

func contractMCP(url string) *mcpServer {
	return &mcpServer{
		agentID:            "agent-1",
		sessionID:          "sess-1",
		taskID:             "task-current",
		orchestrationToken: "orch-token",
		allowOrchestration: true,
		t:                  NewTransport(url, "tok"),
	}
}

// rpcCall sends one tools/call the way an engine does — the arguments as JSON bytes — and returns the
// result and the receipt it carries, after checking that the receipt is the same document in
// structuredContent and, for a write or an invalid call, in the text.
func rpcCall(t *testing.T, s *mcpServer, name string, args map[string]interface{}) (map[string]interface{}, toolReceipt) {
	t.Helper()
	params, err := json.Marshal(map[string]interface{}{"name": name, "arguments": args})
	if err != nil {
		t.Fatal(err)
	}
	resp, respond := s.handle(&rpcRequest{JSONRPC: "2.0", ID: json.RawMessage(`1`), Method: "tools/call", Params: params})
	if !respond || resp.Error != nil {
		t.Fatalf("%s: JSON-RPC error %+v", name, resp.Error)
	}
	// The result as the engine reads it: through the encoder, not as the Go value.
	blob, err := json.Marshal(resp.Result)
	if err != nil {
		t.Fatal(err)
	}
	var result map[string]interface{}
	if err := json.Unmarshal(blob, &result); err != nil {
		t.Fatal(err)
	}
	structured, ok := result["structuredContent"]
	if !ok {
		t.Fatalf("%s answered without structuredContent: %s", name, blob)
	}
	var receipt toolReceipt
	reencoded, _ := json.Marshal(structured)
	if err := json.Unmarshal(reencoded, &receipt); err != nil {
		t.Fatalf("%s: structuredContent is not a receipt: %v", name, err)
	}
	assertReceiptMatchesItsSchema(t, name, structured)
	op := lookupCatalogOperation(name)
	if op.Mutates || receipt.Outcome == outcomeInvalid {
		// The text of a write, and of a call refused before it ran, IS the receipt: a client that
		// reads only the text reads the same document. A read keeps the text it always had.
		content, _ := result["content"].([]interface{})
		text, _ := content[0].(map[string]interface{})["text"].(string)
		var fromText interface{}
		if err := json.Unmarshal([]byte(text), &fromText); err != nil {
			t.Fatalf("%s: the text of a receipt result is not JSON: %v\n%s", name, err, text)
		}
		if !reflect.DeepEqual(fromText, structured) {
			t.Fatalf("%s: text and structuredContent are different documents\ntext: %s\nstructured: %s", name, text, reencoded)
		}
	}
	return result, receipt
}

// assertReceiptMatchesItsSchema checks a receipt against the outputSchema the receipt tools advertise
// — what an MCP client that validates structured output would check.
func assertReceiptMatchesItsSchema(t *testing.T, name string, structured interface{}) {
	t.Helper()
	var violations []argumentViolation
	validateSchemaValue(toolReceiptOutputSchema(), structured, "", &violations)
	if len(violations) > 0 {
		t.Fatalf("%s: the receipt does not match its outputSchema: %+v", name, violations)
	}
}

func idOf(r toolReceipt) string {
	if r.ID == nil {
		return ""
	}
	return *r.ID
}

func statusOf(r toolReceipt) string {
	if r.Status == nil {
		return ""
	}
	return *r.Status
}

func entityAnswer(r *http.Request, _ map[string]interface{}) (int, string) {
	switch {
	case strings.HasSuffix(r.URL.Path, "/runner/tasks/batch-create"):
		return 200, `[{"id":"t1","status":"OPEN","ref":"a"},{"id":"t2","status":"OPEN"}]`
	case strings.Contains(r.URL.Path, "/runner/tasks"):
		return 200, `{"id":"t1","status":"OPEN","title":"Fix login"}`
	case strings.Contains(r.URL.Path, "/projects"):
		return 200, `{"id":"p1","status":"OPEN","title":"Checkout"}`
	case strings.Contains(r.URL.Path, "/task-lists"):
		return 200, `{"id":"l1","title":"Release","paused":false}`
	case strings.Contains(r.URL.Path, "/sessions"):
		return 200, `{"id":"s1","status":"PENDING"}`
	case strings.Contains(r.URL.Path, "/workspaces") || strings.Contains(r.URL.Path, "/agents"):
		return 200, `{"id":"a1","name":"reviewer"}`
	}
	return 200, `{"id":"x1","status":"OPEN"}`
}

// The four mistakes, on the creates and updates of the five objects: each is refused before any
// request — no approval card, no write — with the field named.
func TestContractStrictInputIsRefusedBeforeAnyRequest(t *testing.T) {
	cases := []struct {
		tool    string
		args    map[string]interface{}
		path    string
		problem string
	}{
		// Unknown fields: the misspelling that used to be dropped and read as a write that took.
		{"task_create", map[string]interface{}{"title": "a", "completionCriterion": "EVIDENCE_JUDGMENT", "priorty": 3}, "priorty", violationUnknownField},
		{"task_update", map[string]interface{}{"taskId": "t1", "titel": "b"}, "titel", violationUnknownField},
		{"task_create_batch", map[string]interface{}{"tasks": []interface{}{map[string]interface{}{"title": "a", "completionCriterion": "EVIDENCE_JUDGMENT", "dependsOn": []interface{}{"t0"}}}}, "tasks[0].dependsOn", violationUnknownField},
		{"project_create", map[string]interface{}{"title": "P", "goals": "x"}, "goals", violationUnknownField},
		{"project_update", map[string]interface{}{"projectId": "p1", "titel": "x"}, "titel", violationUnknownField},
		{"tasklist_create", map[string]interface{}{"title": "L", "paused": true}, "paused", violationUnknownField},
		{"tasklist_update", map[string]interface{}{"listId": "l1", "maxConcurent": 2}, "maxConcurent", violationUnknownField},
		{"session_create", map[string]interface{}{"prompt": "go", "agent": "reviewer"}, "agent", violationUnknownField},
		{"agent_create", map[string]interface{}{"name": "r", "systemprompt": "x"}, "systemprompt", violationUnknownField},
		{"agent_update", map[string]interface{}{"agentId": "a1", "workdir": "/tmp"}, "workdir", violationUnknownField},
		// Wrong types.
		{"task_create", map[string]interface{}{"title": "a", "completionCriterion": "EVIDENCE_JUDGMENT", "labels": "bug"}, "labels", violationWrongType},
		{"task_update", map[string]interface{}{"taskId": "t1", "priority": 1.5}, "priority", violationWrongType},
		{"task_create_batch", map[string]interface{}{"tasks": map[string]interface{}{"title": "a"}}, "tasks", violationWrongType},
		{"project_create", map[string]interface{}{"title": 7}, "title", violationWrongType},
		{"project_update", map[string]interface{}{"projectId": "p1", "nonCode": "yes"}, "nonCode", violationWrongType},
		{"tasklist_create", map[string]interface{}{"title": []interface{}{"L"}}, "title", violationWrongType},
		{"tasklist_update", map[string]interface{}{"listId": "l1", "paused": "true"}, "paused", violationWrongType},
		{"session_create", map[string]interface{}{"prompt": "go", "worktree": "false"}, "worktree", violationWrongType},
		{"agent_create", map[string]interface{}{"name": "r", "env": map[string]interface{}{"A": 1}}, "env.A", violationWrongType},
		{"agent_update", map[string]interface{}{"agentId": "a1", "enableWorktree": "on"}, "enableWorktree", violationWrongType},
		// Missing required fields.
		{"task_create", map[string]interface{}{"title": "a"}, "completionCriterion", violationMissingRequired},
		{"task_create_batch", map[string]interface{}{"tasks": []interface{}{map[string]interface{}{"completionCriterion": "EVIDENCE_JUDGMENT"}}}, "tasks[0].title", violationMissingRequired},
		{"project_create", map[string]interface{}{"goal": "g"}, "title", violationMissingRequired},
		{"project_update", map[string]interface{}{"title": "x"}, "projectId", violationMissingRequired},
		{"tasklist_create", map[string]interface{}{}, "title", violationMissingRequired},
		{"tasklist_update", map[string]interface{}{"paused": true}, "listId", violationMissingRequired},
		{"session_create", map[string]interface{}{"title": "t"}, "prompt", violationMissingRequired},
		{"agent_create", map[string]interface{}{"description": "d"}, "name", violationMissingRequired},
		{"agent_update", map[string]interface{}{"name": "r"}, "agentId", violationMissingRequired},
		// Mutually exclusive pairs.
		{"task_create", map[string]interface{}{"title": "a", "completionCriterion": "EVIDENCE_JUDGMENT", "startNow": true, "runAt": "2026-12-01T09:00:00Z"}, "runAt", violationMutuallyExclusive},
		{"task_create", map[string]interface{}{"title": "a", "completionCriterion": "VERIFICATION", "verifiesTaskId": "t0", "verification": map[string]interface{}{"title": "check"}}, "verification", violationMutuallyExclusive},
		{"task_create_batch", map[string]interface{}{"tasks": []interface{}{
			map[string]interface{}{"title": "a", "completionCriterion": "EVIDENCE_JUDGMENT", "ref": "a"},
			map[string]interface{}{"title": "b", "completionCriterion": "EVIDENCE_JUDGMENT", "parentRef": "a", "parentTaskId": "t9"},
		}}, "tasks[1].parentRef", violationMutuallyExclusive},
		{"integration_retry", map[string]interface{}{"projectId": "p1", "taskId": "t1", "promotionId": "pr1", "reason": "flake fixed"}, "promotionId", violationMutuallyExclusive},
	}
	for _, tc := range cases {
		t.Run(tc.tool+" "+tc.problem+" "+tc.path, func(t *testing.T) {
			cs, srv := newContractServer(t, `{"status":"ALLOWED"}`, entityAnswer)
			result, receipt := rpcCall(t, contractMCP(srv.URL), tc.tool, tc.args)

			if got := cs.all(); len(got) != 0 {
				t.Fatalf("an invalid call reached the control plane: %+v", got)
			}
			if result["isError"] != true || receipt.OK || receipt.Outcome != outcomeInvalid {
				t.Fatalf("not refused as invalid: isError=%v ok=%v outcome=%q", result["isError"], receipt.OK, receipt.Outcome)
			}
			if receipt.Error == nil || receipt.Error.Code != errorCodeInvalidArguments || receipt.Error.Retry != retryFixInput || receipt.Error.Retryable {
				t.Fatalf("error = %+v", receipt.Error)
			}
			found := false
			for _, v := range receipt.Error.Violations {
				if v.Problem == tc.problem && (v.Path == tc.path || strings.Contains(v.Message, fmt.Sprintf("%q", tc.path))) {
					found = true
				}
			}
			if !found {
				t.Fatalf("no %s violation naming %q: %+v", tc.problem, tc.path, receipt.Error.Violations)
			}
			if !strings.Contains(receipt.Error.Message, "nothing was written or asked") {
				t.Fatalf("the refusal does not say nothing happened: %q", receipt.Error.Message)
			}
			if receipt.Operation != tc.tool {
				t.Fatalf("operation = %q", receipt.Operation)
			}
		})
	}
}

// A misspelling is answered with the field it most plausibly meant, and an unknown top-level field
// with the whole list of what the tool takes.
func TestContractUnknownFieldNamesTheNearestFieldAndWhatTheToolTakes(t *testing.T) {
	_, srv := newContractServer(t, `{"status":"ALLOWED"}`, entityAnswer)
	_, receipt := rpcCall(t, contractMCP(srv.URL), "task_list", map[string]interface{}{"statuss": "OPEN", "lables": []interface{}{"bug"}})
	byPath := map[string]string{}
	for _, v := range receipt.Error.Violations {
		byPath[v.Path] = v.Message
	}
	if !strings.Contains(byPath["statuss"], `did you mean "status"`) || !strings.Contains(byPath["lables"], `did you mean "labels"`) {
		t.Fatalf("suggestions = %#v", byPath)
	}
	want := declaredFieldNames(lookupCatalogOperation("task_list").MCP.InputSchema)
	if !reflect.DeepEqual(receipt.Error.Accepts, want) {
		t.Fatalf("accepts = %v, want %v", receipt.Error.Accepts, want)
	}
}

// Success: every create and update of the five objects answers with the receipt, whose id is the
// entity's own and whose entity is the server's document as sent.
func TestContractCreatesAndUpdatesOfTheFiveObjectsAnswerWithTheReceipt(t *testing.T) {
	cases := []struct {
		tool          string
		args          map[string]interface{}
		entityType    string
		action        string
		id            string
		status        string
		changedFields []string
		approval      string
	}{
		{"task_create", map[string]interface{}{"title": "Fix login", "description": "the why", "completionCriterion": "EVIDENCE_JUDGMENT", "autoRunWhenReady": false},
			"task", "create", "t1", "OPEN", []string{"assigneeId", "autoRunWhenReady", "completionCriterion", "description", "title"}, approvalOutcomeApproved},
		{"task_update", map[string]interface{}{"taskId": "t1", "title": "Fix login redirect", "labels": []interface{}{"auth"}, "dueDate": nil},
			"task", "update", "t1", "OPEN", []string{"dueDate", "labels", "title"}, approvalOutcomeNotRequired},
		{"project_create", map[string]interface{}{"title": "Checkout", "goal": "one page"},
			"project", "create", "p1", "OPEN", []string{"goal", "title"}, approvalOutcomeApproved},
		{"project_update", map[string]interface{}{"projectId": "p1", "goal": "two pages", "instructions": nil},
			"project", "update", "p1", "OPEN", []string{"goal", "instructions"}, approvalOutcomeNotRequired},
		{"tasklist_create", map[string]interface{}{"title": "Release"},
			"task_list", "create", "l1", "", []string{"title"}, approvalOutcomeNotRequired},
		{"tasklist_update", map[string]interface{}{"listId": "l1", "paused": true, "maxConcurrent": 2},
			"task_list", "update", "l1", "", []string{"maxConcurrent", "paused"}, approvalOutcomeNotRequired},
		{"session_create", map[string]interface{}{"prompt": "Review the change", "title": "Review"},
			"session", "create", "s1", "PENDING", []string{"agentId", "prompt", "title"}, approvalOutcomeNotRequired},
		{"agent_create", map[string]interface{}{"name": "reviewer", "systemPrompt": "Review carefully."},
			"agent", "create", "a1", "", []string{"name", "systemPrompt"}, approvalOutcomeApproved},
		{"agent_update", map[string]interface{}{"agentId": "a1", "description": "reviews"},
			"agent", "update", "a1", "", []string{"description"}, approvalOutcomeNotRequired},
	}
	for _, tc := range cases {
		t.Run(tc.tool, func(t *testing.T) {
			cs, srv := newContractServer(t, `{"status":"ALLOWED","decidedById":"owner-1"}`, entityAnswer)
			result, receipt := rpcCall(t, contractMCP(srv.URL), tc.tool, tc.args)

			if result["isError"] == true || !receipt.OK || receipt.Outcome != outcomeWritten {
				t.Fatalf("not written: isError=%v receipt=%+v", result["isError"], receipt)
			}
			if receipt.ReceiptVersion != toolReceiptVersion || receipt.Operation != tc.tool || receipt.Action != tc.action || receipt.EntityType != tc.entityType {
				t.Fatalf("frame = %d %q %q %q", receipt.ReceiptVersion, receipt.Operation, receipt.Action, receipt.EntityType)
			}
			if idOf(receipt) != tc.id || statusOf(receipt) != tc.status {
				t.Fatalf("id/status = %q/%q, want %q/%q", idOf(receipt), statusOf(receipt), tc.id, tc.status)
			}
			if !reflect.DeepEqual(receipt.ChangedFields, tc.changedFields) {
				t.Fatalf("changedFields = %v, want %v", receipt.ChangedFields, tc.changedFields)
			}
			if receipt.Approval.Outcome != tc.approval {
				t.Fatalf("approval = %+v, want outcome %q", receipt.Approval, tc.approval)
			}
			if tc.approval == approvalOutcomeApproved && (!receipt.Approval.Required || receipt.Approval.Decision != "ALLOWED" || receipt.Approval.DecidedBy != "owner-1" || receipt.Approval.Card == "") {
				t.Fatalf("approval = %+v", receipt.Approval)
			}
			if receipt.Error != nil {
				t.Fatalf("a written receipt carries an error: %+v", receipt.Error)
			}
			var entity map[string]interface{}
			if err := json.Unmarshal(receipt.Entity, &entity); err != nil || entity["id"] != tc.id {
				t.Fatalf("entity = %s (%v)", receipt.Entity, err)
			}
			if len(cs.writes()) != 1 {
				t.Fatalf("writes = %+v", cs.writes())
			}
		})
	}
}

// The batch's receipt maps every item to the id written for it, in input order, with the count.
func TestContractBatchReceiptMapsEveryItem(t *testing.T) {
	_, srv := newContractServer(t, `{"status":"ALLOWED"}`, entityAnswer)
	_, receipt := rpcCall(t, contractMCP(srv.URL), "task_create_batch", map[string]interface{}{"tasks": []interface{}{
		map[string]interface{}{"title": "a", "completionCriterion": "EVIDENCE_JUDGMENT", "ref": "a"},
		map[string]interface{}{"title": "b", "completionCriterion": "EVIDENCE_JUDGMENT", "dependsOnRefs": []interface{}{"a"}},
	}})
	if !receipt.OK || receipt.Count == nil || *receipt.Count != 2 || len(receipt.Items) != 2 {
		t.Fatalf("receipt = %+v", receipt)
	}
	if receipt.Items[0].Ref != "a" || idOf(toolReceipt{ID: receipt.Items[0].ID}) != "t1" || idOf(toolReceipt{ID: receipt.Items[1].ID}) != "t2" {
		t.Fatalf("items = %+v", receipt.Items)
	}
	if receipt.ID != nil {
		t.Fatalf("a batch has no single id: %v", *receipt.ID)
	}
}

// A create that also starts the task says what became of the start in the receipt itself — the
// started session's id — instead of in a paragraph after the document.
func TestContractCreateAndStartReceiptCarriesTheStartedSession(t *testing.T) {
	_, srv := newContractServer(t, `{"status":"ALLOWED"}`, func(r *http.Request, _ map[string]interface{}) (int, string) {
		if strings.HasSuffix(r.URL.Path, "/execute") {
			return 200, `{"id":"s9","status":"PENDING"}`
		}
		return 200, `{"id":"t1","status":"OPEN"}`
	})
	_, receipt := rpcCall(t, contractMCP(srv.URL), "task_create", map[string]interface{}{"title": "Now", "completionCriterion": "EVIDENCE_JUDGMENT", "startNow": true})
	if !receipt.OK || idOf(receipt) != "t1" || receipt.Start == nil {
		t.Fatalf("receipt = %+v", receipt)
	}
	if !receipt.Start.Started || receipt.Start.By != "startNow" || receipt.Start.SessionID == nil || *receipt.Start.SessionID != "s9" {
		t.Fatalf("start = %+v", receipt.Start)
	}
	if !reflect.DeepEqual(receipt.Notes, []string{startedAtOnceNote}) {
		t.Fatalf("notes = %v", receipt.Notes)
	}
}

// A declined card is a refusal with its own outcome, never a success, and nothing is written.
func TestContractDeclinedCardIsARefusalReceipt(t *testing.T) {
	for _, tc := range []struct {
		tool string
		args map[string]interface{}
	}{
		{"task_create", map[string]interface{}{"title": "a", "completionCriterion": "EVIDENCE_JUDGMENT"}},
		{"project_create", map[string]interface{}{"title": "P"}},
		{"task_create_batch", map[string]interface{}{"tasks": []interface{}{map[string]interface{}{"title": "a", "completionCriterion": "EVIDENCE_JUDGMENT"}}}},
		{"agent_create", map[string]interface{}{"name": "r", "systemPrompt": "x"}},
	} {
		t.Run(tc.tool, func(t *testing.T) {
			cs, srv := newContractServer(t, `{"status":"DENIED","message":"not now","decidedById":"owner-1"}`, func(r *http.Request, _ map[string]interface{}) (int, string) {
				if strings.Contains(r.URL.Path, "batch-preview") {
					return 200, `{"tasks":1}`
				}
				return 200, `{"id":"x"}`
			})
			_, receipt := rpcCall(t, contractMCP(srv.URL), tc.tool, tc.args)
			for _, w := range cs.writes() {
				if !strings.Contains(w.Path, "batch-preview") {
					t.Fatalf("a declined card wrote: %+v", cs.writes())
				}
			}
			if receipt.OK || receipt.Outcome != outcomeDeclined {
				t.Fatalf("receipt = %+v", receipt)
			}
			if !receipt.Approval.Required || receipt.Approval.Outcome != approvalOutcomeDeclined || receipt.Approval.Decision != "DENIED" || receipt.Approval.DecidedBy != "owner-1" || receipt.Approval.Message != "not now" {
				t.Fatalf("approval = %+v", receipt.Approval)
			}
			if receipt.Error == nil || receipt.Error.Code != errorCodeApprovalDeclined || receipt.Error.Retry != retryDoNot || receipt.Error.Retryable {
				t.Fatalf("error = %+v", receipt.Error)
			}
			if receipt.ID != nil || len(receipt.ChangedFields) != 0 {
				t.Fatalf("a decline reports a write: id=%v changed=%v", receipt.ID, receipt.ChangedFields)
			}
		})
	}
}

// A refusal the server answered keeps the server's own code and gets the retry rule its status
// means: a boundary is not retried, a conflict is re-read first, a bad input is fixed, a rate limit
// is resent after the time it names, and a 5xx on a keyless create leaves the outcome unknown.
func TestContractServerRefusalsCarryTheirCodeAndRetryRule(t *testing.T) {
	cases := []struct {
		name       string
		status     int
		body       string
		retryAfter string
		outcome    string
		code       string
		retry      string
		retryable  bool
	}{
		{"forbidden", 403, `{"code":"PROJECT_SCOPE_MISMATCH","message":"another project","requiredAction":"FILE_IN_OWN_PROJECT_OR_REQUEST_HANDOFF"}`, "", outcomeRefused, "PROJECT_SCOPE_MISMATCH", retryDoNot, false},
		{"conflict", 409, `{"code":"TASK_ALREADY_RUNNING","message":"running"}`, "", outcomeRefused, "TASK_ALREADY_RUNNING", retryRereadFirst, false},
		{"bad request", 400, `{"message":["title must be a string"]}`, "", outcomeRefused, "HTTP_400", retryFixInput, false},
		{"rate limited", 429, `{"code":"RATE_LIMITED","message":"slow down"}`, "30", outcomeRefused, "RATE_LIMITED", retryResend, true},
		{"server error", 503, `upstream unavailable`, "", outcomeUnknown, "HTTP_503", retryRereadFirst, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch {
				case strings.Contains(r.URL.Path, "/approvals/"):
					_, _ = w.Write([]byte(`{"status":"ALLOWED"}`))
				case strings.HasSuffix(r.URL.Path, "/approvals"):
					_, _ = w.Write([]byte(`{"id":"ap1"}`))
				default:
					if tc.retryAfter != "" {
						w.Header().Set("Retry-After", tc.retryAfter)
					}
					w.WriteHeader(tc.status)
					_, _ = w.Write([]byte(tc.body))
				}
			}))
			t.Cleanup(srv.Close)
			result, receipt := rpcCall(t, contractMCP(srv.URL), "task_create", map[string]interface{}{"title": "a", "completionCriterion": "EVIDENCE_JUDGMENT"})
			if result["isError"] != true || receipt.OK || receipt.Outcome != tc.outcome {
				t.Fatalf("isError=%v receipt=%+v", result["isError"], receipt)
			}
			e := receipt.Error
			if e == nil || e.Code != tc.code || e.HTTPStatus != tc.status || e.Retry != tc.retry || e.Retryable != tc.retryable {
				t.Fatalf("error = %+v", e)
			}
			if tc.retryAfter != "" && e.RetryAfterSeconds != 30 {
				t.Fatalf("retryAfterSeconds = %d", e.RetryAfterSeconds)
			}
			if tc.code == "PROJECT_SCOPE_MISMATCH" && e.RequiredAction != "FILE_IN_OWN_PROJECT_OR_REQUEST_HANDOFF" {
				t.Fatalf("requiredAction = %q", e.RequiredAction)
			}
			// The card was answered yes before the write was refused: the approval is still reported.
			if receipt.Approval.Outcome != approvalOutcomeApproved {
				t.Fatalf("approval = %+v", receipt.Approval)
			}
		})
	}
}

// Timeout, non-idempotent: a create without a key whose answer is lost is sent ONCE — the runner
// does not resend what it cannot prove did not land — and the receipt says the outcome is unknown
// and to re-read before sending it again.
func TestContractLostAnswerOnAKeylessCreateIsNotResentAndSaysRereadFirst(t *testing.T) {
	cs, srv := newContractServer(t, `{"status":"ALLOWED"}`, func(*http.Request, map[string]interface{}) (int, string) { return 0, "" })
	result, receipt := rpcCall(t, contractMCP(srv.URL), "task_create", map[string]interface{}{"title": "a", "completionCriterion": "EVIDENCE_JUDGMENT"})
	if n := len(cs.writes()); n != 1 {
		t.Fatalf("a keyless create was sent %d times", n)
	}
	if result["isError"] != true || receipt.OK || receipt.Outcome != outcomeUnknown {
		t.Fatalf("receipt = %+v", receipt)
	}
	if e := receipt.Error; e == nil || e.Code != errorCodeNoResponse || e.Retry != retryRereadFirst || e.Retryable {
		t.Fatalf("error = %+v", receipt.Error)
	}
	if receipt.Idempotency.Kind != string(idempotencyServerKey) || receipt.Idempotency.Key != "" {
		t.Fatalf("idempotency = %+v", receipt.Idempotency)
	}
}

// Timeout, keyed: the same lost answer on a create that carries the caller's key is sent again
// under that same key, and the second delivery's answer is the receipt.
func TestContractLostAnswerOnAKeyedCreateIsResentUnderTheSameKey(t *testing.T) {
	var mu sync.Mutex
	attempts := 0
	cs, srv := newContractServer(t, `{"status":"ALLOWED"}`, func(*http.Request, map[string]interface{}) (int, string) {
		mu.Lock()
		defer mu.Unlock()
		attempts++
		if attempts == 1 {
			return 0, ""
		}
		return 200, `{"id":"t1","status":"OPEN"}`
	})
	_, receipt := rpcCall(t, contractMCP(srv.URL), "task_create", map[string]interface{}{"title": "a", "completionCriterion": "EVIDENCE_JUDGMENT", "idempotencyKey": "file-login-fix"})
	writes := cs.writes()
	if len(writes) != 2 {
		t.Fatalf("writes = %d, want the lost one and its resend", len(writes))
	}
	for _, w := range writes {
		if w.Body["idempotencyKey"] != "file-login-fix" {
			t.Fatalf("a delivery carried key %v", w.Body["idempotencyKey"])
		}
	}
	if !receipt.OK || idOf(receipt) != "t1" || receipt.Idempotency.Kind != string(idempotencyCallerKey) || receipt.Idempotency.Key != "file-login-fix" {
		t.Fatalf("receipt = %+v", receipt)
	}
}

// Timeout, keyed and still lost: the receipt says a resend under the same key is safe.
func TestContractLostAnswerOnAKeyedCreateSaysResendWithTheSameKey(t *testing.T) {
	cs, srv := newContractServer(t, `{"status":"ALLOWED"}`, func(*http.Request, map[string]interface{}) (int, string) { return 0, "" })
	_, receipt := rpcCall(t, contractMCP(srv.URL), "task_create", map[string]interface{}{"title": "a", "completionCriterion": "EVIDENCE_JUDGMENT", "idempotencyKey": "k1"})
	if n := len(cs.writes()); n != runRequestResendAttempts {
		t.Fatalf("a keyed create was sent %d times, want %d", n, runRequestResendAttempts)
	}
	if receipt.Outcome != outcomeUnknown || receipt.Error == nil || receipt.Error.Retry != retryResend || !receipt.Error.Retryable {
		t.Fatalf("receipt = %+v", receipt)
	}
}

// Duplicate submission: the same create sent twice with the same key is answered with the first
// task, not a second one — the server's caller-key deduplication, which the fake reproduces, and
// the runner's receipt reporting the same id both times.
func TestContractDuplicateSubmissionWithTheSameKeyAnswersTheFirstTask(t *testing.T) {
	byKey := map[string]string{}
	created := 0
	cs, srv := newContractServer(t, `{"status":"ALLOWED"}`, func(r *http.Request, body map[string]interface{}) (int, string) {
		if key, _ := body["idempotencyKey"].(string); key != "" {
			if id, seen := byKey[key]; seen {
				return 200, fmt.Sprintf(`{"id":%q,"status":"OPEN"}`, id)
			}
			created++
			byKey[key] = fmt.Sprintf("t%d", created)
			return 200, fmt.Sprintf(`{"id":%q,"status":"OPEN"}`, byKey[key])
		}
		created++
		return 200, fmt.Sprintf(`{"id":"t%d","status":"OPEN"}`, created)
	})
	s := contractMCP(srv.URL)
	args := map[string]interface{}{"title": "a", "completionCriterion": "EVIDENCE_JUDGMENT", "idempotencyKey": "file-login-fix"}
	_, first := rpcCall(t, s, "task_create", args)
	_, second := rpcCall(t, s, "task_create", args)
	if idOf(first) == "" || idOf(first) != idOf(second) || created != 1 {
		t.Fatalf("first %q second %q, created %d", idOf(first), idOf(second), created)
	}
	if len(cs.writes()) != 2 {
		t.Fatalf("writes = %d", len(cs.writes()))
	}
}

// Non-idempotent retry: without a key nothing makes a second send the same request, so a blind
// retry writes twice — which is why the receipt names the retry rule instead of leaving it to the
// caller to guess. The catalogue says so too.
func TestContractNonIdempotentRetryWritesAgainAndTheReceiptSaysSo(t *testing.T) {
	created := 0
	_, srv := newContractServer(t, `{"status":"ALLOWED"}`, func(*http.Request, map[string]interface{}) (int, string) {
		created++
		return 200, fmt.Sprintf(`{"id":"t%d","status":"OPEN"}`, created)
	})
	s := contractMCP(srv.URL)
	args := map[string]interface{}{"title": "a", "completionCriterion": "EVIDENCE_JUDGMENT"}
	_, first := rpcCall(t, s, "task_create", args)
	_, second := rpcCall(t, s, "task_create", args)
	if idOf(first) == idOf(second) || created != 2 {
		t.Fatalf("two keyless sends wrote %d task(s): %q %q", created, idOf(first), idOf(second))
	}
	for _, r := range []toolReceipt{first, second} {
		if r.Idempotency.Kind != string(idempotencyServerKey) {
			t.Fatalf("a keyless create claims %q", r.Idempotency.Kind)
		}
	}
	op := lookupCatalogOperation("task_create")
	if op.Idempotency != idempotencyCallerKey || !strings.Contains(op.Retry, "re-read") {
		t.Fatalf("catalogue: %q / %q", op.Idempotency, op.Retry)
	}
	// And an operation with no key at all says re-read first on a lost answer.
	cs, srv2 := newContractServer(t, `{"status":"ALLOWED"}`, func(*http.Request, map[string]interface{}) (int, string) { return 0, "" })
	_, lost := rpcCall(t, contractMCP(srv2.URL), "task_update", map[string]interface{}{"taskId": "t1", "title": "b"})
	if len(cs.writes()) != 1 || lost.Idempotency.Kind != string(idempotencyNone) || lost.Error == nil || lost.Error.Retry != retryRereadFirst {
		t.Fatalf("task_update lost answer: writes=%d receipt=%+v", len(cs.writes()), lost)
	}
}

// Every catalogued tool that writes answers with the receipt — not only the five objects' — and
// every read carries it beside its text. The arguments are the smallest the schema accepts, so a
// handler that refuses them for a reason of its own still has to answer in the receipt's shape.
func TestContractEveryCataloguedToolAnswersWithAReceipt(t *testing.T) {
	skip := map[string]bool{
		// Wait for a task or a session to settle, which a fake that never settles one cannot end.
		"task_await": true, "session_await": true,
	}
	for _, op := range buildOperationCatalog() {
		if op.MCP == nil || !op.answersWithReceipt() || skip[op.Tool] {
			continue
		}
		op := op
		t.Run(op.Tool, func(t *testing.T) {
			_, srv := newContractServer(t, `{"status":"ALLOWED"}`, entityAnswer)
			args := minimalArguments(op.MCP.InputSchema)
			result, receipt := rpcCall(t, contractMCP(srv.URL), op.Tool, args)
			if receipt.Operation != op.Tool || receipt.Outcome == "" {
				t.Fatalf("receipt = %+v", receipt)
			}
			if receipt.Outcome == outcomeInvalid {
				t.Fatalf("the minimal arguments were refused as invalid: %+v", receipt.Error)
			}
			if receipt.OK == (result["isError"] == true) && receipt.Outcome != outcomeDeclined && receipt.Outcome != outcomePending {
				// isError is the transport's word, ok the receipt's: an error result is never ok.
				if result["isError"] == true {
					t.Fatalf("an error result says ok: %+v", receipt)
				}
			}
			if !receipt.OK && receipt.Error == nil {
				t.Fatalf("a failed receipt carries no error: %+v", receipt)
			}
		})
	}
}

// minimalArguments is the smallest value a schema accepts: only the required properties, each the
// simplest value of its type (an enum's first member).
func minimalArguments(schema map[string]interface{}) map[string]interface{} {
	value, _ := minimalValue(schema).(map[string]interface{})
	if value == nil {
		value = map[string]interface{}{}
	}
	return value
}

func minimalValue(schema map[string]interface{}) interface{} {
	if enum, ok := schema["enum"].([]string); ok && len(enum) > 0 {
		return enum[0]
	}
	if enum, ok := schema["enum"].([]interface{}); ok && len(enum) > 0 {
		return enum[0]
	}
	types := schemaTypes(schema["type"])
	t := ""
	if len(types) > 0 {
		t = types[0]
	}
	switch t {
	case "object":
		out := map[string]interface{}{}
		props, _ := schema["properties"].(map[string]interface{})
		for _, name := range schemaRequired(schema["required"]) {
			prop, _ := props[name].(map[string]interface{})
			out[name] = minimalValue(prop)
		}
		return out
	case "array":
		items, _ := schema["items"].(map[string]interface{})
		n := 0
		if min, ok := schemaNumber(schema["minItems"]); ok {
			n = int(min)
		}
		out := make([]interface{}, n)
		for i := range out {
			out[i] = minimalValue(items)
		}
		return out
	case "integer", "number":
		if min, ok := schemaNumber(schema["minimum"]); ok {
			return min
		}
		return 1.0
	case "boolean":
		return true
	case "null":
		return nil
	case "string":
		n := 1
		if min, ok := schemaNumber(schema["minLength"]); ok && int(min) > n {
			n = int(min)
		}
		return strings.Repeat("x", n)
	}
	return "x"
}

// The schemas only use what the validator checks, so a schema never promises a check nobody makes.
func TestCatalogSchemasUseOnlyTheValidatedSubset(t *testing.T) {
	var walk func(tool, path string, schema map[string]interface{})
	walk = func(tool, path string, schema map[string]interface{}) {
		for key, value := range schema {
			if !schemaKeywordsValidated[key] {
				t.Errorf("%s %s uses %q, which the validator does not check", tool, path, key)
			}
			switch key {
			case "properties":
				props, _ := value.(map[string]interface{})
				for name, prop := range props {
					if child, ok := prop.(map[string]interface{}); ok {
						walk(tool, path+"."+name, child)
					}
				}
			case "items", "additionalProperties":
				if child, ok := value.(map[string]interface{}); ok {
					walk(tool, path+"."+key, child)
				}
			}
		}
	}
	for _, op := range buildOperationCatalog() {
		if op.MCP != nil {
			walk(op.Tool, "inputSchema", op.MCP.InputSchema)
		}
	}
}

// Every advertised object that names its properties is closed to the rest, and says so; only the
// engine's own permission bridge, and free-form values the server validates, stay open.
func TestEveryAdvertisedObjectSchemaIsClosed(t *testing.T) {
	var walk func(tool, path string, schema map[string]interface{})
	walk = func(tool, path string, schema map[string]interface{}) {
		if props, ok := schema["properties"].(map[string]interface{}); ok {
			if _, stated := schema["additionalProperties"]; !stated {
				t.Errorf("%s %s declares properties but is not closed", tool, path)
			}
			for name, prop := range props {
				if child, ok := prop.(map[string]interface{}); ok {
					walk(tool, path+"."+name, child)
				}
			}
		}
		if items, ok := schema["items"].(map[string]interface{}); ok {
			walk(tool, path+"[]", items)
		}
	}
	for _, descriptor := range toolDescriptors(true, true) {
		name, _ := descriptor["name"].(string)
		schema, _ := descriptor["inputSchema"].(map[string]interface{})
		if openInputTools[name] {
			if _, closed := schema["additionalProperties"]; closed {
				t.Errorf("%s is the engine's own protocol and must stay open", name)
			}
			continue
		}
		walk(name, "inputSchema", schema)
	}
}

// The creates and updates of the five objects, and the start, advertise the receipt's schema; no
// other tool's own outputSchema is replaced.
func TestReceiptOutputSchemaIsAdvertisedOnTheFiveObjectsWrites(t *testing.T) {
	advertised := map[string]bool{}
	for _, descriptor := range toolDescriptors(true, true) {
		name, _ := descriptor["name"].(string)
		schema, has := descriptor["outputSchema"]
		if !has {
			continue
		}
		if isReceiptSchema(schema) {
			advertised[name] = true
		} else if !strings.HasPrefix(name, "wiki_") {
			t.Errorf("%s advertises an outputSchema that is neither the receipt's nor a wiki answer's", name)
		}
	}
	var want []string
	for tool := range receiptSchemaTools {
		want = append(want, tool)
	}
	var got []string
	for tool := range advertised {
		got = append(got, tool)
	}
	sort.Strings(want)
	sort.Strings(got)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("receipt outputSchema on %v, want %v", got, want)
	}
}

// The CLI's --receipt is the MCP receipt of the same write: the same operation, outcome, id, status,
// changed fields, approval and idempotency — and stdout is that one document.
func TestCLIReceiptMapsToTheMCPReceipt(t *testing.T) {
	cs, srv := newContractServer(t, `{"status":"ALLOWED","decidedById":"owner-1"}`, entityAnswer)
	configureCLITestRunner(t, srv.URL)
	t.Setenv("ORBIT_AGENT_ID", "agent-1")
	t.Setenv("ORBIT_SESSION_ID", "sess-1")
	t.Setenv("ORBIT_TASK_ID", "")

	var out, errOut bytes.Buffer
	err := runOrbitCLI([]string{"task", "create", "--title", "Fix login", "--description", "the why",
		"--completion-criterion", "EVIDENCE_JUDGMENT", "--auto-run-when-ready=false", "--idempotency-key", "file-login-fix", "--receipt"},
		strings.NewReader(""), &out, &errOut)
	if err != nil {
		t.Fatalf("%v\nstderr: %s", err, errOut.String())
	}
	var cli toolReceipt
	if err := json.Unmarshal(out.Bytes(), &cli); err != nil {
		t.Fatalf("stdout is not one receipt: %v\n%s", err, out.String())
	}
	var generic interface{}
	_ = json.Unmarshal(out.Bytes(), &generic)
	assertReceiptMatchesItsSchema(t, "orbit task create --receipt", generic)

	_, mcp := rpcCall(t, contractMCP(srv.URL), "task_create", map[string]interface{}{"title": "Fix login", "description": "the why",
		"completionCriterion": "EVIDENCE_JUDGMENT", "autoRunWhenReady": false, "idempotencyKey": "file-login-fix"})

	type mapped struct {
		OK            bool
		Outcome       string
		Operation     string
		Action        string
		EntityType    string
		ID, Status    string
		ChangedFields []string
		Approval      string
		Idempotency   receiptIdempotency
	}
	project := func(r toolReceipt) mapped {
		return mapped{r.OK, r.Outcome, r.Operation, r.Action, r.EntityType, idOf(r), statusOf(r), r.ChangedFields, r.Approval.Outcome, r.Idempotency}
	}
	if !reflect.DeepEqual(project(cli), project(mcp)) {
		t.Fatalf("the two surfaces disagree\n cli: %+v\n mcp: %+v", project(cli), project(mcp))
	}
	if len(cs.writes()) != 2 {
		t.Fatalf("writes = %+v", cs.writes())
	}
}

// The CLI refuses a --tasks document that does not fit task_create_batch's schema before it asks or
// sends anything, and --receipt answers with the same INVALID_ARGUMENTS receipt MCP gives.
func TestCLIRefusesAnInvalidBatchDocumentBeforeAnyRequest(t *testing.T) {
	cs, srv := newContractServer(t, `{"status":"ALLOWED"}`, entityAnswer)
	configureCLITestRunner(t, srv.URL)
	t.Setenv("ORBIT_AGENT_ID", "agent-1")
	t.Setenv("ORBIT_SESSION_ID", "sess-1")

	for _, doc := range []string{
		`[{"title":"a","completionCriterion":"EVIDENCE_JUDGMENT","priorty":1}]`,
		`[{"title":"a","completionCriterion":"EVIDENCE_JUDGMENT","labels":"bug"}]`,
		`[{"completionCriterion":"EVIDENCE_JUDGMENT"}]`,
		`[{"title":"a","completionCriterion":"EVIDENCE_JUDGMENT","startNow":true,"runAt":"2026-12-01T09:00:00Z"}]`,
		`{"tasks":[{"title":"a","completionCriterion":"EVIDENCE_JUDGMENT"}],"dryRun":true}`,
	} {
		var out, errOut bytes.Buffer
		err := runOrbitCLI([]string{"task", "create-batch", "--tasks", doc, "--receipt"}, strings.NewReader(""), &out, &errOut)
		if err == nil {
			t.Fatalf("%s was accepted", doc)
		}
		var receipt toolReceipt
		if jsonErr := json.Unmarshal(out.Bytes(), &receipt); jsonErr != nil {
			t.Fatalf("%s: stdout is not a receipt: %v\n%s", doc, jsonErr, out.String())
		}
		if receipt.Outcome != outcomeInvalid || receipt.Error == nil || receipt.Error.Code != errorCodeInvalidArguments {
			t.Fatalf("%s: receipt = %+v", doc, receipt)
		}
		// And without --receipt, the same refusal as the command's error.
		if err := runOrbitCLI([]string{"task", "create-batch", "--tasks", doc}, strings.NewReader(""), &out, &errOut); err == nil || !strings.Contains(err.Error(), "nothing was written or asked") {
			t.Fatalf("%s: plain run error = %v", doc, err)
		}
	}
	if got := cs.all(); len(got) != 0 {
		t.Fatalf("an invalid batch reached the control plane: %+v", got)
	}
}

// A card declined at the terminal is the same refusal receipt, and a non-zero exit.
func TestCLIReceiptForADeclinedCard(t *testing.T) {
	cs, srv := newContractServer(t, `{"status":"DENIED","message":"not now","decidedById":"owner-1"}`, entityAnswer)
	configureCLITestRunner(t, srv.URL)
	t.Setenv("ORBIT_AGENT_ID", "agent-1")
	t.Setenv("ORBIT_SESSION_ID", "sess-1")
	var out, errOut bytes.Buffer
	err := runOrbitCLI([]string{"task", "create", "--title", "a", "--completion-criterion", "EVIDENCE_JUDGMENT", "--receipt"}, strings.NewReader(""), &out, &errOut)
	if err == nil {
		t.Fatal("a declined create exited zero")
	}
	var receipt toolReceipt
	if jsonErr := json.Unmarshal(out.Bytes(), &receipt); jsonErr != nil {
		t.Fatalf("stdout is not a receipt: %v\n%s", jsonErr, out.String())
	}
	if receipt.Outcome != outcomeDeclined || receipt.Approval.Outcome != approvalOutcomeDeclined || receipt.Error == nil || receipt.Error.Code != errorCodeApprovalDeclined {
		t.Fatalf("receipt = %+v", receipt)
	}
	if len(cs.writes()) != 0 {
		t.Fatalf("a declined create wrote: %+v", cs.writes())
	}
}

// The receipt's schema is published once, in the agent contract's machine-readable index, and that
// copy is the code's: a field added to the receipt without the contract saying so fails here. The
// contract's two version statements agree with each other while they are at it.
func TestAgentContractPublishesTheReceiptSchemaTheCodeAnswersWith(t *testing.T) {
	raw, err := os.ReadFile("../../contracts/orbit-agent.contract.json")
	if err != nil {
		t.Fatal(err)
	}
	var contract struct {
		ContractVersion string `json:"contractVersion"`
		Receipt         struct {
			Version int         `json:"version"`
			Schema  interface{} `json:"schema"`
		} `json:"receipt"`
	}
	if err := json.Unmarshal(raw, &contract); err != nil {
		t.Fatal(err)
	}
	blob, _ := json.Marshal(toolReceiptOutputSchema())
	var code interface{}
	_ = json.Unmarshal(blob, &code)
	if !reflect.DeepEqual(contract.Receipt.Schema, code) {
		t.Fatalf("contracts/orbit-agent.contract.json receipt.schema is not the receipt the code answers with:\n%s", blob)
	}
	if contract.Receipt.Version != toolReceiptVersion {
		t.Fatalf("receipt.version = %d, the code's is %d", contract.Receipt.Version, toolReceiptVersion)
	}
	doc, err := os.ReadFile("../../docs/orbit-agent-contract.md")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(doc), "frozen at v"+contract.ContractVersion+",") {
		t.Fatalf("docs/orbit-agent-contract.md's header does not name contractVersion %s", contract.ContractVersion)
	}
}

// task_start's receipt is the run it started: the session's id, as the contract's start receipt
// requires — and a start the server skipped (it answers 2xx with ok:false) is a refusal, not a run.
func TestContractTaskStartReceiptIsTheStartedSessionAndASkipIsARefusal(t *testing.T) {
	_, srv := newContractServer(t, `{"status":"ALLOWED"}`, func(*http.Request, map[string]interface{}) (int, string) {
		return 200, `{"ok":true,"sessionId":"s7"}`
	})
	_, started := rpcCall(t, contractMCP(srv.URL), "task_start", map[string]interface{}{"taskId": "t1"})
	if !started.OK || started.EntityType != string(objectSession) || idOf(started) != "s7" || started.Action != "start" {
		t.Fatalf("receipt = %+v", started)
	}

	_, srv2 := newContractServer(t, `{"status":"ALLOWED"}`, func(*http.Request, map[string]interface{}) (int, string) {
		return 200, `{"ok":false,"skipped":"superseded"}`
	})
	_, skipped := rpcCall(t, contractMCP(srv2.URL), "task_start", map[string]interface{}{"taskId": "t1"})
	if skipped.OK || skipped.Outcome != outcomeRefused || skipped.Error == nil || skipped.Error.Code != errorCodeNotDone ||
		!strings.Contains(skipped.Error.Message, "superseded") || skipped.Error.Retry != retryDoNot {
		t.Fatalf("receipt = %+v", skipped)
	}

	// The same skip on a create's start: the task is written, its start is reported deferred.
	_, srv3 := newContractServer(t, `{"status":"ALLOWED"}`, func(r *http.Request, _ map[string]interface{}) (int, string) {
		if strings.HasSuffix(r.URL.Path, "/execute") {
			return 200, `{"ok":false,"skipped":"project-cancelled"}`
		}
		return 200, `{"id":"t1","status":"OPEN"}`
	})
	_, created := rpcCall(t, contractMCP(srv3.URL), "task_create", map[string]interface{}{"title": "Now", "completionCriterion": "EVIDENCE_JUDGMENT", "startNow": true})
	if !created.OK || idOf(created) != "t1" || created.Start == nil || created.Start.Started || !strings.Contains(created.Start.Deferred, "project-cancelled") {
		t.Fatalf("receipt = %+v start = %+v", created, created.Start)
	}
}
