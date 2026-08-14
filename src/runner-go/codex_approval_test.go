package main

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"strings"
	"sync"
	"testing"
	"time"
)

// The decision vocabulary is verified against codex's own protocol crate: the v2 thread requests
// (item/commandExecution|fileChange/requestApproval) answer with accept/decline, while the older
// exec/apply-patch requests answer with approved/denied. Sending the wrong word for the family
// either denies an approval the user granted or, worse, is read as something else entirely.
func TestClassifyCodexApprovalAndDecisionVocabulary(t *testing.T) {
	for _, tc := range []struct {
		method     string
		fileChange bool
		legacy     bool
		allow      string
		deny       string
		tool       string
	}{
		{"item/commandExecution/requestApproval", false, false, "accept", "decline", "Bash"},
		{"item/fileChange/requestApproval", true, false, "accept", "decline", "apply_patch"},
		{"execCommandApproval", false, true, "approved", "denied", "Bash"},
		{"applyPatchApproval", true, true, "approved", "denied", "apply_patch"},
	} {
		request, ok := classifyCodexApproval(tc.method)
		if !ok {
			t.Fatalf("%s was not recognized as an approval request", tc.method)
		}
		if request.fileChange != tc.fileChange || request.legacy != tc.legacy {
			t.Fatalf("%s classified as %+v", tc.method, request)
		}
		if got := request.decision(true); got != tc.allow {
			t.Errorf("%s allow decision = %q, want %q", tc.method, got, tc.allow)
		}
		if got := request.decision(false); got != tc.deny {
			t.Errorf("%s deny decision = %q, want %q", tc.method, got, tc.deny)
		}
		if got := request.toolName(); got != tc.tool {
			t.Errorf("%s tool name = %q, want %q", tc.method, got, tc.tool)
		}
	}
	if _, ok := classifyCodexApproval("thread/started"); ok {
		t.Fatal("a notification method was treated as an approval request")
	}
}

// Only the modes whose whole point is being consulted turn approvals on. Auto is one of them on
// Codex too — "on-request" is its name for letting the model decide when to ask. Don't Ask stays
// on "never" until Codex is handed an allowlist: it is the agent default, and fail-closed with no
// allowlist would deny every command in a task-launched run.
func TestCodexApprovalPolicyPerMode(t *testing.T) {
	for mode, want := range map[string]string{
		"default":           "untrusted",
		"acceptEdits":       "untrusted",
		"plan":              "untrusted",
		"auto":              "on-request",
		"dontAsk":           "never",
		"bypassPermissions": "never",
		"":                  "never",
	} {
		if got := codexApprovalPolicy(mode); got != want {
			t.Errorf("codexApprovalPolicy(%q) = %q, want %q", mode, got, want)
		}
	}
}

func TestCodexAutomaticApprovalAppliesModeWithoutAHuman(t *testing.T) {
	fileChange := codexApprovalRequest{fileChange: true}
	command := codexApprovalRequest{}
	// Plan mode is read-only: nothing executes or edits, no prompt needed.
	if allowed, decided := codexAutomaticApproval("plan", command); !decided || allowed {
		t.Errorf("plan/command = (%v, %v), want denied without asking", allowed, decided)
	}
	if allowed, decided := codexAutomaticApproval("plan", fileChange); !decided || allowed {
		t.Errorf("plan/fileChange = (%v, %v), want denied without asking", allowed, decided)
	}
	// Accept Edits pre-approves file changes but still asks about commands.
	if allowed, decided := codexAutomaticApproval("acceptEdits", fileChange); !decided || !allowed {
		t.Errorf("acceptEdits/fileChange = (%v, %v), want allowed without asking", allowed, decided)
	}
	if _, decided := codexAutomaticApproval("acceptEdits", command); decided {
		t.Error("acceptEdits/command must reach the user")
	}
	// Default consults the user for both.
	if _, decided := codexAutomaticApproval("default", command); decided {
		t.Error("default/command must reach the user")
	}
}

// readLoop calls handleServerRequest inline, so an approval that blocks on a human must not be
// answered on that goroutine: doing so stalls the only reader of codex's stdout and wedges the
// session. This proves a slow approval still lets other traffic through, and that the response
// eventually lands.
func TestHandleServerRequestDoesNotBlockTheReadLoop(t *testing.T) {
	clientReader, serverWriter := io.Pipe() // codex -> Orbit
	serverReader, clientWriter := io.Pipe() // Orbit -> codex
	release := make(chan struct{})
	app := &codexAppServer{
		ctx:           context.Background(),
		stdin:         clientWriter,
		pending:       map[string]chan codexRPCMessage{},
		notifications: make(chan codexRPCMessage, 8),
		done:          make(chan struct{}),
		approve: func(context.Context, codexApprovalRequest, map[string]interface{}) bool {
			<-release // a human taking their time
			return true
		},
	}
	go app.readLoop(clientReader)

	var wg sync.WaitGroup
	wg.Add(1)
	var replies []map[string]interface{}
	go func() {
		defer wg.Done()
		sc := bufio.NewScanner(serverReader)
		for sc.Scan() {
			var msg map[string]interface{}
			if json.Unmarshal(sc.Bytes(), &msg) == nil {
				replies = append(replies, msg)
			}
			return // one reply is all this test needs
		}
	}()

	_, _ = io.WriteString(serverWriter, `{"id":1,"method":"item/commandExecution/requestApproval","params":{"command":"rm -rf /","cwd":"/tmp"}}`+"\n")
	// While that approval is pending, a notification must still be delivered.
	_, _ = io.WriteString(serverWriter, `{"method":"thread/started","params":{"thread":{"id":"t1"}}}`+"\n")
	select {
	case msg := <-app.notifications:
		if msg.Method != "thread/started" {
			t.Fatalf("notification = %q", msg.Method)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the read loop was blocked by a pending approval")
	}

	close(release)
	wg.Wait()
	if len(replies) != 1 {
		t.Fatalf("replies = %#v", replies)
	}
	result, _ := replies[0]["result"].(map[string]interface{})
	if result["decision"] != "accept" {
		t.Fatalf("decision = %#v, want accept", result["decision"])
	}
	_ = serverWriter.Close()
	_ = clientWriter.Close()
}

// Without a bridge (and on every error path inside it) the answer must be a refusal, never an
// approval: a control-plane outage must not become a silent yes.
func TestHandleServerRequestFailsClosedWithoutABridge(t *testing.T) {
	serverReader, clientWriter := io.Pipe()
	app := &codexAppServer{
		ctx:           context.Background(),
		stdin:         clientWriter,
		pending:       map[string]chan codexRPCMessage{},
		notifications: make(chan codexRPCMessage, 4),
		done:          make(chan struct{}),
	}
	go app.handleServerRequest(codexRPCMessage{
		ID:     float64(7),
		Method: "item/fileChange/requestApproval",
		Params: json.RawMessage(`{"itemId":"i1"}`),
	})
	line := make(chan string, 1)
	go func() {
		sc := bufio.NewScanner(serverReader)
		if sc.Scan() {
			line <- sc.Text()
		}
	}()
	select {
	case got := <-line:
		if !strings.Contains(got, `"decision":"decline"`) {
			t.Fatalf("reply = %s, want a decline", got)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no reply")
	}
	_ = clientWriter.Close()
}

// Captured from codex 0.147 answering a real `orbit` MCP tool call: consent is an empty form
// whose _meta says what it really is. Answering it with the old -32601 catch-all failed the tool
// call outright ("user rejected MCP tool call"), which is how every Orbit MCP tool broke inside a
// Codex session.
const codexMCPConsentParams = `{
  "threadId": "01a000bf-452d-7450-bd1b-f0199ec16026",
  "turnId": "01a000bf-47d7-71e3-a06c-54eceae1ddbf",
  "serverName": "orbit",
  "mode": "form",
  "_meta": {
    "codex_approval_kind": "mcp_tool_call",
    "tool_description": "List the caller's tasks.",
    "tool_params": {"status": "CANCELLED"}
  },
  "message": "Allow the orbit MCP server to run tool \"task_list\"?",
  "requestedSchema": {"type": "object", "properties": {}}
}`

func codexElicitationReply(t *testing.T, params string, approve codexApprovalFn) map[string]interface{} {
	t.Helper()
	serverReader, clientWriter := io.Pipe()
	app := &codexAppServer{
		ctx:           context.Background(),
		stdin:         clientWriter,
		pending:       map[string]chan codexRPCMessage{},
		notifications: make(chan codexRPCMessage, 4),
		done:          make(chan struct{}),
		approve:       approve,
	}
	defer func() { _ = clientWriter.Close() }()
	go app.handleServerRequest(codexRPCMessage{
		ID:     float64(3),
		Method: codexMCPElicitationMethod,
		Params: json.RawMessage(params),
	})
	line := make(chan string, 1)
	go func() {
		sc := bufio.NewScanner(serverReader)
		if sc.Scan() {
			line <- sc.Text()
		}
	}()
	select {
	case got := <-line:
		var reply map[string]interface{}
		if err := json.Unmarshal([]byte(got), &reply); err != nil {
			t.Fatalf("reply %s: %v", got, err)
		}
		if reply["error"] != nil {
			t.Fatalf("reply = %s, want an elicitation result rather than a JSON-RPC error", got)
		}
		result, _ := reply["result"].(map[string]interface{})
		return result
	case <-time.After(2 * time.Second):
		t.Fatal("no reply")
		return nil
	}
}

func TestHandleServerRequestAnswersMCPToolConsent(t *testing.T) {
	var gotRequest codexApprovalRequest
	var gotParams map[string]interface{}
	result := codexElicitationReply(t, codexMCPConsentParams,
		func(_ context.Context, request codexApprovalRequest, params map[string]interface{}) bool {
			gotRequest, gotParams = request, params
			return true
		})
	if result["action"] != "accept" {
		t.Fatalf("action = %#v, want accept", result["action"])
	}
	// The consent form asked for no fields, so an accepted one answers with an empty object;
	// null content is reserved for decline.
	if content, ok := result["content"].(map[string]interface{}); !ok || len(content) != 0 {
		t.Fatalf("content = %#v, want an empty object", result["content"])
	}
	if !gotRequest.mcpTool || gotRequest.toolName() != "mcp__orbit" {
		t.Fatalf("approval request = %+v", gotRequest)
	}
	if gotParams["serverName"] != "orbit" {
		t.Fatalf("the card was not given the elicitation params: %#v", gotParams)
	}

	denied := codexElicitationReply(t, codexMCPConsentParams,
		func(context.Context, codexApprovalRequest, map[string]interface{}) bool { return false })
	if denied["action"] != "decline" || denied["content"] != nil {
		t.Fatalf("denied reply = %#v", denied)
	}
}

// An elicitation Orbit has no card for (a real input form, or a URL to open) is still answered —
// declining leaves the MCP server free to report that itself, where an error reply fails the call.
func TestHandleServerRequestDeclinesUnrenderableElicitation(t *testing.T) {
	result := codexElicitationReply(t,
		`{"serverName":"acme","mode":"url","message":"Sign in","url":"https://example.com","elicitationId":"e1"}`,
		func(context.Context, codexApprovalRequest, map[string]interface{}) bool {
			t.Error("a form Orbit cannot render must not reach the approval card")
			return true
		})
	if result["action"] != "decline" {
		t.Fatalf("action = %#v, want decline", result["action"])
	}
}

// Codex asks for MCP consent even under "never", the policy the non-asking modes run on. Those
// modes have to answer it themselves: an unattended task run has no human to wait for.
func TestCodexAutomaticApprovalAnswersMCPConsentInSilentModes(t *testing.T) {
	mcpTool := codexApprovalRequest{mcpTool: true, server: "orbit"}
	for _, mode := range []string{"dontAsk", "bypassPermissions", ""} {
		if allowed, decided := codexAutomaticApproval(mode, mcpTool); !decided || !allowed {
			t.Errorf("%q/mcpTool = (%v, %v), want allowed without asking", mode, allowed, decided)
		}
	}
	for _, mode := range []string{"default", "auto", "acceptEdits"} {
		if _, decided := codexAutomaticApproval(mode, mcpTool); decided {
			t.Errorf("%q/mcpTool must reach the user", mode)
		}
	}
	if allowed, decided := codexAutomaticApproval("plan", mcpTool); !decided || allowed {
		t.Errorf("plan/mcpTool = (%v, %v), want denied without asking", allowed, decided)
	}
}

// A cancelled session must not leave an approval poll running, and must not approve.
func TestBridgeCodexApprovalFailsClosedOnCancelledContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	job := &ClaimedSession{SessionID: "s1"}
	job.Agent.PermissionMode = "default"
	if bridgeCodexApproval(ctx, nil, job, codexApprovalRequest{}, map[string]interface{}{}) {
		t.Fatal("a cancelled approval was granted")
	}
}

// A refused command came back as a GREEN success card with an empty body: Codex reports the
// refusal as status "declined", which codexItemIsError did not recognize, so the transcript
// contradicted the decision the user had just made. Both stream casings must read as an error
// and explain themselves.
func TestHandleCodexItemRendersADeclinedCommandAsRefused(t *testing.T) {
	for _, itemType := range []string{"commandExecution", "command_execution"} {
		item := map[string]interface{}{
			"type": itemType, "id": "exec-1",
			"command":          "/bin/bash -lc 'touch /tmp/probe'",
			"status":           "declined",
			"aggregatedOutput": "",
		}
		done := captureCodexItem(item, true)
		if len(done) != 1 || done[0].typ != evToolResult {
			t.Fatalf("%s completed = %+v, want one tool_result", itemType, done)
		}
		if done[0].payload["isError"] != true {
			t.Fatalf("%s isError = %#v, want true", itemType, done[0].payload["isError"])
		}
		if content, _ := done[0].payload["content"].(string); !strings.Contains(content, "did not run") {
			t.Fatalf("%s content = %q, want an explanation", itemType, content)
		}
	}
}

// A declined patch has no diff to show, for the same reason.
func TestHandleCodexItemRendersADeclinedPatchAsRefused(t *testing.T) {
	item := map[string]interface{}{"type": "fileChange", "id": "patch-1", "status": "declined"}
	done := captureCodexItem(item, true)
	if len(done) != 1 || done[0].payload["isError"] != true {
		t.Fatalf("completed = %+v, want an errored tool_result", done)
	}
	if content, _ := done[0].payload["content"].(string); !strings.Contains(content, "not applied") {
		t.Fatalf("content = %q, want an explanation", content)
	}
}

// A real failure must keep its own output; only the empty declined case is substituted.
func TestHandleCodexItemKeepsRealFailureOutput(t *testing.T) {
	item := map[string]interface{}{
		"type": "commandExecution", "id": "exec-2",
		"status": "failed", "aggregatedOutput": "bash: nope: command not found\n",
	}
	done := captureCodexItem(item, true)
	if done[0].payload["isError"] != true || done[0].payload["content"] != "bash: nope: command not found\n" {
		t.Fatalf("failure result = %#v", done[0].payload)
	}
}

// Codex logs an ERROR line for a refusal the user chose. That is the bridge working, so it must
// not surface as a red error block — while genuine failures still do.
func TestCodexStderrRefusalFilter(t *testing.T) {
	refusal := `2026-08-14T08:02:28.299610Z ERROR codex_core::tools::router: error=exec_command failed for ` +
		"`/bin/bash -lc 'touch /tmp/probe'`" + `: CreateProcess { message: "Rejected(\"rejected by user\")" }`
	if !codexStderrIsExpectedRefusal(refusal) {
		t.Fatal("the user's own refusal was not recognized")
	}
	for _, keep := range []string{
		`2026-08-14T08:02:28Z ERROR codex_core::tools::router: error=exec_command failed: Permission denied`,
		`2026-08-14T08:02:28Z ERROR codex_core: stream disconnected`,
		`2026-08-14T08:02:28Z  INFO codex_core: rejected by user`, // not an ERROR line
	} {
		if codexStderrIsExpectedRefusal(keep) {
			t.Fatalf("a line that must stay visible was filtered: %s", keep)
		}
	}
}
