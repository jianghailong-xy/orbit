package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
)

// ── bounded views: task_list, task_evidence_list, session_get (bounded_views.go) ────────────────
//
// The shapes are the 2026-11-12 incident's: a 63-task project whose rows carry 3,000-character
// acceptance criteria (task_list answered 184,025 characters and was refused), an evidence ledger
// of multi-kilobyte claims and notes, and a session whose prompt is 42,200 characters.

func boundedToolText(t *testing.T, res map[string]interface{}) string {
	t.Helper()
	if res["isError"] == true {
		t.Fatalf("tool returned an error: %#v", res["content"])
	}
	content, _ := res["content"].([]map[string]interface{})
	text, _ := content[0]["text"].(string)
	return text
}

// fakeTaskPages answers /runner/tasks/page over n tasks, newest first, cursor = offset.
func fakeTaskPages(t *testing.T, n int, title func(i int) string, labels []string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/runner/tasks/page" {
			t.Errorf("unexpected request %s", r.URL.Path)
			http.NotFound(w, r)
			return
		}
		offset, _ := strconv.Atoi(r.URL.Query().Get("cursor"))
		limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
		var items []map[string]interface{}
		for i := offset; i < n && i < offset+limit; i++ {
			items = append(items, map[string]interface{}{
				"id": fmt.Sprintf("task%02d", i), "title": title(i), "status": "OPEN", "projectId": "proj1",
				"acceptanceCriteria": strings.Repeat("c", 3000), "labels": labels, "priority": 0,
				"updatedAt": "2026-11-12T17:03:18.000Z", "completionCriterion": "EVIDENCE_JUDGMENT",
			})
		}
		page := map[string]interface{}{"items": items, "nextCursor": nil}
		if offset+limit < n {
			page["nextCursor"] = strconv.Itoa(offset + limit)
		}
		_ = json.NewEncoder(w).Encode(page)
	}))
	t.Cleanup(srv.Close)
	return srv
}

var cursorLine = `cursor="`

func summaryCursorOf(text string) string {
	i := strings.Index(text, cursorLine)
	if i < 0 {
		return ""
	}
	rest := text[i+len(cursorLine):]
	return rest[:strings.Index(rest, `"`)]
}

func summaryIDs(t *testing.T, text string) []string {
	t.Helper()
	var ids []string
	for _, line := range strings.Split(strings.TrimSpace(text), "\n")[1:] {
		var row map[string]interface{}
		if err := json.Unmarshal([]byte(line), &row); err != nil {
			t.Fatalf("summary row is not one JSON object: %q", line)
		}
		if _, full := row["acceptanceCriteria"]; full {
			t.Fatalf("a summary row carries acceptanceCriteria: %q", line)
		}
		ids = append(ids, row["id"].(string))
	}
	return ids
}

func TestMCPTaskListDefaultIsABoundedSummaryWithTheNextCursor(t *testing.T) {
	srv := fakeTaskPages(t, 63, func(i int) string { return fmt.Sprintf("Task %d", i) }, nil)
	mcp := &mcpServer{t: NewTransport(srv.URL, "tok")}

	first := boundedToolText(t, mcp.callTool("task_list", map[string]interface{}{"projectId": "proj1"}))
	if len(first) > toolResultBudget {
		t.Fatalf("default task_list = %d characters, budget %d", len(first), toolResultBudget)
	}
	ids := summaryIDs(t, first)
	if len(ids) != defaultTaskSummaryLimit || ids[0] != "task00" {
		t.Fatalf("first page = %d rows from %v", len(ids), ids[:1])
	}
	cursor := summaryCursorOf(first)
	if cursor == "" {
		t.Fatalf("a page with more after it names no cursor: %q", strings.SplitN(first, "\n", 2)[0])
	}

	second := boundedToolText(t, mcp.callTool("task_list", map[string]interface{}{"projectId": "proj1", "cursor": cursor}))
	rest := summaryIDs(t, second)
	if len(rest) != 13 || rest[0] != "task50" || !strings.Contains(second, "This is the last page.") {
		t.Fatalf("second page = %v; header %q", rest, strings.SplitN(second, "\n", 2)[0])
	}

	full := boundedToolText(t, mcp.callTool("task_list", map[string]interface{}{"projectId": "proj1", "summary": false, "cursor": cursor}))
	if !strings.Contains(full, strings.Repeat("c", 3000)) {
		t.Fatal("summary=false does not return full rows")
	}
}

// A page whose summary rows still pass the budget is fetched again smaller rather than cut, so
// the cursor it names continues exactly after the last row shown.
func TestMCPTaskListShrinksAPageThatWouldPassTheBudget(t *testing.T) {
	labels := make([]string, 16)
	for i := range labels {
		labels[i] = fmt.Sprintf("label-%02d-%s", i, strings.Repeat("x", 30))
	}
	srv := fakeTaskPages(t, 63, func(i int) string { return fmt.Sprintf("%d %s", i, strings.Repeat("t", 400)) }, labels)
	mcp := &mcpServer{t: NewTransport(srv.URL, "tok")}

	text := boundedToolText(t, mcp.callTool("task_list", map[string]interface{}{}))
	if len(text) > toolResultBudget {
		t.Fatalf("task_list = %d characters, budget %d", len(text), toolResultBudget)
	}
	ids := summaryIDs(t, text)
	if len(ids) >= defaultTaskSummaryLimit {
		t.Fatalf("the oversized page was not shrunk: %d rows", len(ids))
	}
	if got, want := summaryCursorOf(text), strconv.Itoa(len(ids)); got != want {
		t.Fatalf("cursor = %q after %d rows; want %q", got, len(ids), want)
	}
}

func TestTaskCLIListSummaryMatchesTheTool(t *testing.T) {
	srv := fakeTaskPages(t, 63, func(i int) string { return fmt.Sprintf("Task %d", i) }, nil)
	configureCLITestRunner(t, srv.URL)
	var out bytes.Buffer
	if err := cmdTaskCLI([]string{"list", "--summary", "--cursor", "60"}, strings.NewReader(""), &out); err != nil {
		t.Fatal(err)
	}
	if ids := summaryIDs(t, out.String()); len(ids) != 3 || ids[0] != "task60" {
		t.Fatalf("--summary --cursor 60 = %v", ids)
	}
	if err := cmdTaskCLI([]string{"list", "--summary", "--all"}, strings.NewReader(""), &out); err == nil {
		t.Fatal("--summary with --all was accepted")
	}
}

func fakeEvidenceLedger(t *testing.T, revisions int) *httptest.Server {
	t.Helper()
	var ledger []map[string]interface{}
	for i := 1; i <= revisions; i++ {
		ledger = append(ledger, map[string]interface{}{
			"revision": strconv.Itoa(i), "submittedAt": "2026-11-12T18:16:49.603Z", "sourceSessionId": "s1",
			"evidence": map[string]interface{}{
				"claim":  fmt.Sprintf("claim %d %s", i, strings.Repeat("k", 5000)),
				"checks": []interface{}{map[string]interface{}{"kind": "TOOL_CALL", "ref": "bgj_1", "command": strings.Repeat("g", 2000)}},
				"gaps":   []interface{}{strings.Repeat("p", 2000)},
			},
			"decision": map[string]interface{}{"decision": "SEND_BACK", "note": strings.Repeat("n", 3000), "decidedAt": "2026-11-12T18:17:41.715Z", "decidedByType": "AGENT"},
		})
	}
	body, _ := json.Marshal(ledger)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/runner/tasks/task1/evidence" {
			t.Errorf("unexpected request %s", r.URL.Path)
		}
		_, _ = w.Write(body)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func evidenceRevisionsShown(t *testing.T, text string) []string {
	t.Helper()
	var page []map[string]interface{}
	if err := json.Unmarshal([]byte(text[strings.Index(text, "\n")+1:]), &page); err != nil {
		t.Fatalf("summary page is not a JSON list: %v", err)
	}
	var revs []string
	for _, rev := range page {
		revs = append(revs, rev["revision"].(string))
		if claim, _ := rev["claim"].(string); len(claim) > evidenceTextLimit+40 {
			t.Fatalf("revision %v claim not shortened: %d", rev["revision"], len(claim))
		}
	}
	return revs
}

func TestMCPTaskEvidenceListDefaultIsTheNewestSummaryPage(t *testing.T) {
	srv := fakeEvidenceLedger(t, 30)
	mcp := &mcpServer{t: NewTransport(srv.URL, "tok")}

	newest := boundedToolText(t, mcp.callTool("task_evidence_list", map[string]interface{}{"taskId": "task1"}))
	if len(newest) > toolResultBudget {
		t.Fatalf("default task_evidence_list = %d characters, budget %d", len(newest), toolResultBudget)
	}
	if revs := evidenceRevisionsShown(t, newest); len(revs) != evidenceSummaryPageSize || revs[0] != "21" || revs[9] != "30" {
		t.Fatalf("newest page = %v", revs)
	}
	if !strings.Contains(newest, `before="21"`) {
		t.Fatalf("header names no older page: %q", strings.SplitN(newest, "\n", 2)[0])
	}

	older := boundedToolText(t, mcp.callTool("task_evidence_list", map[string]interface{}{"taskId": "task1", "before": "21"}))
	if revs := evidenceRevisionsShown(t, older); revs[0] != "11" || revs[len(revs)-1] != "20" {
		t.Fatalf("before=21 page = %v", revs)
	}

	one := boundedToolText(t, mcp.callTool("task_evidence_list", map[string]interface{}{"taskId": "task1", "revision": float64(5)}))
	if !strings.Contains(one, "claim 5 "+strings.Repeat("k", 5000)) || strings.Contains(one, "claim 6 ") {
		t.Fatal("revision=5 does not answer that one revision in full")
	}

	all := boundedToolText(t, mcp.callTool("task_evidence_list", map[string]interface{}{"taskId": "task1", "summary": false}))
	if !strings.Contains(all, "claim 1 ") || !strings.Contains(all, "claim 30 ") || !strings.Contains(all, strings.Repeat("n", 3000)) {
		t.Fatal("summary=false does not answer the whole ledger")
	}

	if res := mcp.callTool("task_evidence_list", map[string]interface{}{"taskId": "task1", "revision": "99"}); res["isError"] != true {
		t.Fatal("an unknown revision was not an error")
	}
}

func fakeSession(t *testing.T, record map[string]interface{}) *httptest.Server {
	t.Helper()
	body, _ := json.Marshal(record)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(body)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestMCPSessionGetKeepsTheCollectedReplyWholeWhileShorteningThePrompt(t *testing.T) {
	reply := "reply " + strings.Repeat("r", 6000)
	result := "result " + strings.Repeat("s", 5500)
	srv := fakeSession(t, map[string]interface{}{
		"id": "sess1", "status": "AWAITING_INPUT", "prompt": strings.Repeat("p", 42200),
		"lastAssistantText": reply, "result": result,
	})
	mcp := &mcpServer{t: NewTransport(srv.URL, "tok"), sessionID: "caller", allowOrchestration: true}

	text := boundedToolText(t, mcp.callTool("session_get", map[string]interface{}{"sessionId": "sess1"}))
	if len(text) > toolResultBudget {
		t.Fatalf("default session_get = %d characters, budget %d", len(text), toolResultBudget)
	}
	if !strings.Contains(text, reply) || !strings.Contains(text, result) {
		t.Fatal("lastAssistantText or result was shortened though the record fits with them whole")
	}
	if !strings.Contains(text, `"truncatedFields"`) || !strings.Contains(text, `"characters": 42200`) || !strings.Contains(text, "summary=false") {
		t.Fatalf("the shortened prompt is not reported: %q", text[:200])
	}

	full := boundedToolText(t, mcp.callTool("session_get", map[string]interface{}{"sessionId": "sess1", "summary": false}))
	if !strings.Contains(full, strings.Repeat("p", 42200)) {
		t.Fatal("summary=false does not return the full record")
	}
}

func TestMCPSessionGetLeavesARecordThatFitsUntouched(t *testing.T) {
	record := map[string]interface{}{"id": "sess1", "status": "SUCCEEDED", "prompt": "short", "lastAssistantText": "done"}
	srv := fakeSession(t, record)
	mcp := &mcpServer{t: NewTransport(srv.URL, "tok"), sessionID: "caller", allowOrchestration: true}
	body, _ := json.Marshal(record)
	if got := boundedToolText(t, mcp.callTool("session_get", map[string]interface{}{"sessionId": "sess1"})); got != prettyJSON(body) {
		t.Fatalf("a record that fits was changed: %q", got)
	}
}

// A record nothing small enough can save — every field huge — is shortened all the way down,
// the collected reply last.
func TestBoundSessionRecordShortensTheReplyOnlyWhenNothingElseIsLeft(t *testing.T) {
	raw, _ := json.Marshal(map[string]interface{}{
		"prompt": strings.Repeat("p", 42200), "lastUserText": strings.Repeat("u", 30000),
		"lastAssistantText": strings.Repeat("a", 30000), "result": strings.Repeat("s", 30000),
		"changedFiles": make([]interface{}, 39000),
	})
	text, err := boundSessionRecord(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(text) > toolResultBudget {
		t.Fatalf("bounded record = %d characters, budget %d", len(text), toolResultBudget)
	}
	for _, field := range []string{"prompt", "changedFiles", "lastUserText", "lastAssistantText", "result"} {
		if !strings.Contains(text, `"`+field+`": {`) {
			t.Fatalf("%s not reported in truncatedFields", field)
		}
	}
}
