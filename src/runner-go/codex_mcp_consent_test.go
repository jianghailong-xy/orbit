//go:build linux || darwin

package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// consentCard is one row of the fake approval table.
type consentCard struct {
	ID        string
	ToolUseID string
	ToolName  string
	Input     map[string]interface{}
}

// fakeApprovalTable answers the two approval routes the way the apiserver does
// (RunnerApiController.createApproval): a non-empty toolUseId finds its row, and otherwise a row is
// created under the constraint the real table has, approval_session_id_tool_use_id_key, for which
// the empty string is a value like any other. A card is decided ALLOWED unless denied names it, so a
// call that lands on another call's row is answered yes, which is what a colliding id would do to a
// real one.
type fakeApprovalTable struct {
	mu     sync.Mutex
	cards  []consentCard
	denied map[string]bool // by card id
}

func (f *fakeApprovalTable) serve(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if r.Method == http.MethodGet {
		parts := strings.Split(r.URL.Path, "/")
		id := parts[len(parts)-1]
		status := "ALLOWED"
		if f.denied[id] {
			status = "DENIED"
		}
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"id": id, "status": status})
		return
	}
	var body struct {
		ToolUseID string                 `json:"toolUseId"`
		ToolName  string                 `json:"toolName"`
		Input     map[string]interface{} `json:"input"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	for _, card := range f.cards {
		if card.ToolUseID != body.ToolUseID {
			continue
		}
		if body.ToolUseID == "" {
			http.Error(w, `{"message":"Unique constraint failed on the constraint: approval_session_id_tool_use_id_key"}`, http.StatusInternalServerError)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"id": card.ID, "status": "ALLOWED"})
		return
	}
	card := consentCard{ID: fmt.Sprintf("approval-%d", len(f.cards)+1), ToolUseID: body.ToolUseID, ToolName: body.ToolName, Input: body.Input}
	f.cards = append(f.cards, card)
	_ = json.NewEncoder(w).Encode(map[string]interface{}{"id": card.ID, "status": "PENDING"})
}

// deny has the card of this id answered with a refusal.
func (f *fakeApprovalTable) deny(id string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.denied == nil {
		f.denied = map[string]bool{}
	}
	f.denied[id] = true
}

func (f *fakeApprovalTable) snapshot() []consentCard {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]consentCard(nil), f.cards...)
}

// consentSession is one Codex session in an ask mode: the runner's real read loop and approval
// bridge, with Codex on one end of a pipe and the fake table on the other.
type consentSession struct {
	table   *fakeApprovalTable
	toCodex chan map[string]interface{}
	codex   io.WriteCloser
}

func newConsentSession(t *testing.T, mode string) *consentSession {
	t.Helper()
	table := &fakeApprovalTable{}
	server := httptest.NewServer(http.HandlerFunc(table.serve))
	t.Cleanup(server.Close)
	transport := NewTransport(server.URL, "runner-token")
	job := &ClaimedSession{SessionID: "session-1"}
	job.Agent.PermissionMode = mode

	codexOut, codex := io.Pipe()
	runnerOut, runnerIn := io.Pipe()
	ctx, cancel := context.WithCancel(context.Background())
	app := &codexAppServer{
		ctx:           ctx,
		stdin:         runnerIn,
		pending:       map[string]chan codexRPCMessage{},
		notifications: make(chan codexRPCMessage, 8),
		done:          make(chan struct{}),
		consentScope:  "process-1",
		approve: func(approvalCtx context.Context, request codexApprovalRequest, params map[string]interface{}) bool {
			return bridgeCodexApproval(approvalCtx, transport, job, request, params)
		},
	}
	go app.readLoop(codexOut)

	session := &consentSession{table: table, toCodex: make(chan map[string]interface{}, 8), codex: codex}
	go func() {
		scanner := bufio.NewScanner(runnerOut)
		for scanner.Scan() {
			var reply map[string]interface{}
			if json.Unmarshal(scanner.Bytes(), &reply) == nil {
				session.toCodex <- reply
			}
		}
	}()
	t.Cleanup(func() {
		cancel()
		_ = codex.Close()
		_ = runnerIn.Close()
	})
	return session
}

// raise writes one server request onto Codex's stdout.
func (s *consentSession) raise(t *testing.T, id int, method, params string) {
	t.Helper()
	line := fmt.Sprintf(`{"id":%d,"method":%q,"params":%s}`, id, method, strings.ReplaceAll(params, "\n", " "))
	if _, err := io.WriteString(s.codex, line+"\n"); err != nil {
		t.Fatal(err)
	}
}

// answers reads the next n replies, keyed by the JSON-RPC id they answer.
func (s *consentSession) answers(t *testing.T, n int) map[int]map[string]interface{} {
	t.Helper()
	got := map[int]map[string]interface{}{}
	for i := 0; i < n; i++ {
		select {
		case reply := <-s.toCodex:
			id, _ := reply["id"].(float64)
			result, _ := reply["result"].(map[string]interface{})
			got[int(id)] = result
		case <-time.After(5 * time.Second):
			t.Fatalf("got %d of %d replies: %#v", i, n, got)
		}
	}
	return got
}

// consentParams is the request Codex 0.166 sends for one MCP tool call, as captured from the real
// CLI: thread and turn, the tool's arguments and description, and nothing that names the call.
func consentParams(tool string) string {
	return fmt.Sprintf(`{
	  "threadId": "01a19d20-a2e0-7551-8555-a79b5ec6afa8",
	  "turnId": "01a19d20-a314-7fa0-8fff-069ba2d6ea81",
	  "serverName": "orbit",
	  "mode": "form",
	  "_meta": {
	    "codex_approval_kind": "mcp_tool_call",
	    "persist": ["session", "always"],
	    "tool_description": "A tool.",
	    "tool_params": {"note": %q},
	    "tool_params_display": [{"name": "note", "value": %q, "display_name": "note"}]
	  },
	  "message": "Allow the orbit MCP server to run tool \"%s\"?",
	  "requestedSchema": {"type": "object", "properties": {}}
	}`, tool, tool, tool)
}

// Only the first MCP call of a Codex session in an ask mode ever reached a person. Consent carries
// no itemId, so every card was filed under the empty string, the second write failed on the table's unique
// constraint, the bridge failed closed, and Codex told the model "user rejected MCP tool call"
// about a card nobody had seen.
func TestEveryMCPConsentOfACodexSessionGetsItsOwnCard(t *testing.T) {
	for _, mode := range []string{"default", "acceptEdits"} {
		t.Run(mode, func(t *testing.T) {
			session := newConsentSession(t, mode)
			session.raise(t, 0, codexMCPElicitationMethod, consentParams("bg_run"))
			// Answered before the next is raised, as Codex does for calls made one after another.
			first := session.answers(t, 1)
			session.raise(t, 1, codexMCPElicitationMethod, consentParams("bg_output"))
			second := session.answers(t, 1)

			if first[0]["action"] != "accept" || second[1]["action"] != "accept" {
				t.Fatalf("replies = %#v, %#v; want both accepted", first, second)
			}
			cards := session.table.snapshot()
			if len(cards) != 2 {
				t.Fatalf("cards = %#v, want one per request", cards)
			}
			if cards[0].ToolUseID == "" || cards[0].ToolUseID == cards[1].ToolUseID {
				t.Fatalf("toolUseIds %q and %q, want two different ids", cards[0].ToolUseID, cards[1].ToolUseID)
			}
			if !strings.Contains(fmt.Sprint(cards[0].Input["message"]), "bg_run") || !strings.Contains(fmt.Sprint(cards[1].Input["message"]), "bg_output") {
				t.Fatalf("cards ask about %#v and %#v", cards[0].Input, cards[1].Input)
			}
			if cards[0].ToolName != "mcp__orbit__bg_run" || cards[1].ToolName != "mcp__orbit__bg_output" {
				t.Fatalf("cards are named %q and %q", cards[0].ToolName, cards[1].ToolName)
			}
		})
	}
}

// Codex can call tools in parallel, which leaves several consents open at once and in no particular
// order: each still needs a card, and each answer has to go back under its own request.
func TestConcurrentMCPConsentsOfACodexSessionEachGetACard(t *testing.T) {
	session := newConsentSession(t, "default")
	session.raise(t, 3, codexMCPElicitationMethod, consentParams("beta"))
	session.raise(t, 4, codexMCPElicitationMethod, consentParams("alpha"))
	replies := session.answers(t, 2)
	if replies[3]["action"] != "accept" || replies[4]["action"] != "accept" {
		t.Fatalf("replies = %#v", replies)
	}
	cards := session.table.snapshot()
	if len(cards) != 2 {
		t.Fatalf("cards = %#v, want one per request", cards)
	}
	names := map[string]bool{cards[0].ToolName: true, cards[1].ToolName: true}
	if !names["mcp__orbit__alpha"] || !names["mcp__orbit__beta"] {
		t.Fatalf("cards = %#v, want each named for the tool its own request asks about", cards)
	}
}

// One call's answer says nothing about the next: three requests for one tool with the same arguments
// are three questions, and a no in the middle is a no to that call alone.
func TestEachAnswerReachesOnlyTheMCPConsentItWasGivenFor(t *testing.T) {
	session := newConsentSession(t, "default")
	session.table.deny("approval-2")
	want := map[int]string{0: "accept", 1: "decline", 2: "accept"}
	for id := 0; id < 3; id++ {
		session.raise(t, id, codexMCPElicitationMethod, consentParams("bg_run"))
		if got := session.answers(t, 1)[id]["action"]; got != want[id] {
			t.Fatalf("request %d answered %v, want %s", id, got, want[id])
		}
	}
	if cards := session.table.snapshot(); len(cards) != 3 {
		t.Fatalf("cards = %#v, want one per request", cards)
	}
}

// Answered out of order, each answer still goes back under its own request.
func TestConcurrentMCPConsentsAreAnsweredUnderTheirOwnRequests(t *testing.T) {
	session := newConsentSession(t, "default")
	session.table.deny("approval-1")
	session.raise(t, 3, codexMCPElicitationMethod, consentParams("beta"))
	// Filed one at a time, so that approval-1 is known to be the first request's card.
	for deadline := time.Now().Add(5 * time.Second); len(session.table.snapshot()) == 0; time.Sleep(time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatal("the first request filed no card")
		}
	}
	session.raise(t, 4, codexMCPElicitationMethod, consentParams("alpha"))
	replies := session.answers(t, 2)
	if replies[3]["action"] != "decline" || replies[4]["action"] != "accept" {
		t.Fatalf("replies = %#v, want the refused card's request declined and the other accepted", replies)
	}
}

// What the card is named, from the message Codex 0.166 words it in. A wording this does not know, or a
// name a rule would read as a wildcard, leaves the card naming the server alone: naming the wrong
// tool would be worse than naming none.
func TestCodexMCPConsentToolNamesOneToolOrNone(t *testing.T) {
	for _, tc := range []struct {
		message string
		card    string
	}{
		{`Allow the acme MCP server to run tool "bg_run"?`, "mcp__acme__bg_run"},
		// A tool with a title is still asked about by its name.
		{`Allow the acme MCP server to run tool "titled_tool"?`, "mcp__acme__titled_tool"},
		{`Allow the acme MCP server to run tool "dotted.tool"?`, "mcp__acme__dotted.tool"},
		{`Allow this app to run tool "search"?`, "mcp__acme__search"},
		{`Allow the acme MCP server to run tool "*"?`, "mcp__acme"},
		{`Allow the acme MCP server to run tool "a*"?`, "mcp__acme"},
		{`Allow the acme MCP server to run tool ""?`, "mcp__acme"},
		{`Allow the acme MCP server to run tool "?`, "mcp__acme"},
		{`Allow the acme MCP server to run tool "bg_run"`, "mcp__acme"},
		{`Run bg_run on the acme MCP server?`, "mcp__acme"},
		{``, "mcp__acme"},
	} {
		request := codexApprovalRequest{mcpTool: true, server: "acme", tool: codexMCPConsentTool(map[string]interface{}{"message": tc.message})}
		if got := request.toolName(); got != tc.card {
			t.Errorf("message %q files a card named %q, want %q", tc.message, got, tc.card)
		}
	}
}

// A card that cannot name its tool is still a card: the person is asked, and only the name is less
// than it could be.
func TestAnMCPConsentInAnUnknownWordingStillReachesAPerson(t *testing.T) {
	session := newConsentSession(t, "default")
	params := strings.Replace(consentParams("bg_run"), `Allow the orbit MCP server to run tool \"bg_run\"?`, `Run bg_run?`, 1)
	if params == consentParams("bg_run") {
		t.Fatal("the message was not replaced")
	}
	session.raise(t, 0, codexMCPElicitationMethod, params)
	if got := session.answers(t, 1)[0]["action"]; got != "accept" {
		t.Fatalf("reply = %v", got)
	}
	cards := session.table.snapshot()
	if len(cards) != 1 || cards[0].ToolName != "mcp__orbit" || cards[0].ToolUseID == "" {
		t.Fatalf("cards = %#v, want one card that names the server", cards)
	}
}

// Codex sends a consent still open again when the thread is resumed, under the same JSON-RPC id
// (measured on 0.166). It is the same question, so it finds the card already filed.
func TestAReplayedMCPConsentKeepsItsOneCard(t *testing.T) {
	session := newConsentSession(t, "default")
	params := consentParams("bg_run")
	session.raise(t, 0, codexMCPElicitationMethod, params)
	replies := session.answers(t, 1)
	session.raise(t, 0, codexMCPElicitationMethod, params)
	replay := session.answers(t, 1)
	if replies[0]["action"] != "accept" || replay[0]["action"] != "accept" {
		t.Fatalf("replies = %#v, replay = %#v", replies, replay)
	}
	if cards := session.table.snapshot(); len(cards) != 1 {
		t.Fatalf("cards = %#v, want the replay to find the first card", cards)
	}
}

// A request's JSON-RPC id is a counter that starts at 0 in every Codex process (measured on 0.166),
// and a restarted engine resumes the same thread. If the id named the card by that number alone, the
// new process's first call would find the old process's card and take its yes: a call nobody was
// asked about, run with no card at all. The process has to be part of the name.
func TestAnMCPConsentFromANewCodexProcessIsANewCard(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	dir := t.TempDir()
	bin := t.TempDir()
	request := fmt.Sprintf(`{"id":0,"method":%q,"params":%s}`, codexMCPElicitationMethod, strings.ReplaceAll(consentParams("bg_run"), "\n", " "))
	writeFakeBin(t, bin, "codex", "printf '%s\\n' '"+request+"'\nexec cat >/dev/null")
	t.Setenv("PATH", bin+":"+"/usr/bin:/bin")

	table := &fakeApprovalTable{}
	server := httptest.NewServer(http.HandlerFunc(table.serve))
	defer server.Close()
	transport := NewTransport(server.URL, "runner-token")
	job := &ClaimedSession{SessionID: "session-1"}
	job.Agent.PermissionMode = "default"

	for process := 1; process <= 2; process++ {
		answered := make(chan bool, 1)
		app, err := startCodexAppServer(context.Background(), job, dir, dir, envWithAgent(job.Agent.Env),
			func(string, map[string]interface{}) {},
			func(ctx context.Context, approval codexApprovalRequest, params map[string]interface{}) bool {
				allowed := bridgeCodexApproval(ctx, transport, job, approval, params)
				answered <- allowed
				return allowed
			})
		if err != nil {
			t.Fatal(err)
		}
		select {
		case <-answered:
		case <-time.After(10 * time.Second):
			t.Fatalf("process %d: its consent was never answered", process)
		}
		app.close()
		if cards := table.snapshot(); len(cards) != process {
			t.Fatalf("after process %d: cards = %#v, want a card of its own for each process", process, cards)
		}
	}
}

// Commands and patches have an id of their own, which stays what names their card: it is what pairs
// a card with its call's result (SessionsService.stillBeingAsked).
func TestACodexCommandApprovalStillNamesItsItem(t *testing.T) {
	session := newConsentSession(t, "default")
	session.raise(t, 0, "item/commandExecution/requestApproval", `{"itemId":"call_exec_1","command":"ls","cwd":"/tmp"}`)
	if replies := session.answers(t, 1); replies[0]["decision"] != "accept" {
		t.Fatalf("replies = %#v", replies)
	}
	cards := session.table.snapshot()
	if len(cards) != 1 || cards[0].ToolUseID != "call_exec_1" {
		t.Fatalf("cards = %#v, want the item's own id", cards)
	}
}
