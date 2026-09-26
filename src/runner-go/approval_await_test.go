package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// approvalDoor is an apiserver whose approval door answers the first `outage` polls with a 502 — the
// apiserver being rebuilt under a running session — and then with `answer`. It counts the cards
// filed and the polls made, because "the card was read again" is only true on the wire.
func approvalDoor(t *testing.T, outage int32, answer string) (url string, filed, polls *atomic.Int32) {
	t.Helper()
	filed, polls = &atomic.Int32{}, &atomic.Int32{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.Contains(r.URL.Path, "/approvals/"):
			if polls.Add(1) <= outage {
				w.WriteHeader(http.StatusBadGateway)
				_, _ = w.Write([]byte("error code: 502"))
				return
			}
			_, _ = w.Write([]byte(answer))
		case strings.HasSuffix(r.URL.Path, "/approvals"):
			filed.Add(1)
			_, _ = w.Write([]byte(`{"id":"ap1","status":"PENDING"}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(srv.Close)
	return srv.URL, filed, polls
}

func fastApprovalRetry(t *testing.T) {
	t.Helper()
	restore := approvalPollRetryDelay
	approvalPollRetryDelay = time.Millisecond
	t.Cleanup(func() { approvalPollRetryDelay = restore })
}

func permissionPromptText(t *testing.T, res map[string]interface{}) string {
	t.Helper()
	content, ok := res["content"].([]map[string]interface{})
	if !ok || len(content) == 0 {
		t.Fatalf("permission_prompt result content = %#v", res["content"])
	}
	text, _ := content[0]["text"].(string)
	return text
}

// 2026-09-26: an ExitPlanMode card was on the owner's screen when the apiserver was redeployed. The
// prompt's poll got one 502 and denied; the engine asked again, the owner approved the second card,
// and the first sat PENDING on the conversation's row as "Waiting for approval". The card and the
// loop reading it must outlive the door going down.
func TestPermissionPromptKeepsReadingTheCardThroughADoorOutage(t *testing.T) {
	fastApprovalRetry(t)
	url, filed, polls := approvalDoor(t, 2, `{"status":"ALLOWED"}`)
	srv := &mcpServer{allowPermissionPrompt: true, sessionID: "sess-1", t: NewTransport(url, "tok")}

	text := permissionPromptText(t, srv.callTool("permission_prompt", map[string]interface{}{
		"tool_name":   "ExitPlanMode",
		"input":       map[string]interface{}{"plan": "# the plan"},
		"tool_use_id": "call_00_plan",
	}))

	if !strings.Contains(text, `"behavior":"allow"`) {
		t.Fatalf("an outage ended the prompt instead of being waited out: %s", text)
	}
	if filed.Load() != 1 {
		t.Fatalf("filed %d cards, want the one the owner is looking at", filed.Load())
	}
	if polls.Load() != 3 {
		t.Fatalf("polled %d times, want the two 502s and the answer", polls.Load())
	}
}

// A refusal from the door IS an answer about the card, so the prompt stops and denies — fail closed —
// instead of spinning on a card that is gone.
func TestPermissionPromptDeniesWhenTheCardIsGone(t *testing.T) {
	fastApprovalRetry(t)
	polls := &atomic.Int32{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/approvals/") {
			polls.Add(1)
			w.WriteHeader(http.StatusNotFound)
			return
		}
		_, _ = w.Write([]byte(`{"id":"ap1","status":"PENDING"}`))
	}))
	t.Cleanup(srv.Close)
	mcp := &mcpServer{allowPermissionPrompt: true, sessionID: "sess-1", t: NewTransport(srv.URL, "tok")}

	text := permissionPromptText(t, mcp.callTool("permission_prompt", map[string]interface{}{
		"tool_name": "Bash", "input": map[string]interface{}{"command": "ls"}, "tool_use_id": "call_1",
	}))

	if !strings.Contains(text, `"behavior":"deny"`) || !strings.Contains(text, "approval poll failed") {
		t.Fatalf("a card that cannot be read must deny, got %s", text)
	}
	if polls.Load() != 1 {
		t.Fatalf("polled %d times, want one: a 404 is not asked twice", polls.Load())
	}
}

// A card the server settled without anybody deciding it (ABANDONED) is not an allow, and it is not a
// reason to read it again either: the old loop re-polled on anything but ALLOWED/DENIED, which on a
// terminal status is a request loop with no wait in it.
func TestPermissionPromptDeniesACardSettledWithoutADecision(t *testing.T) {
	fastApprovalRetry(t)
	url, _, polls := approvalDoor(t, 0,
		`{"status":"ABANDONED","message":"the call that asked this already returned"}`)
	srv := &mcpServer{allowPermissionPrompt: true, sessionID: "sess-1", t: NewTransport(url, "tok")}

	text := permissionPromptText(t, srv.callTool("permission_prompt", map[string]interface{}{
		"tool_name": "Bash", "input": map[string]interface{}{"command": "ls"}, "tool_use_id": "call_1",
	}))

	if !strings.Contains(text, `"behavior":"deny"`) || !strings.Contains(text, "already returned") {
		t.Fatalf("a settled card must deny with the server's reason, got %s", text)
	}
	if polls.Load() != 1 {
		t.Fatalf("polled %d times, want one", polls.Load())
	}
}

func TestCodexApprovalKeepsReadingTheCardThroughADoorOutage(t *testing.T) {
	fastApprovalRetry(t)
	url, filed, polls := approvalDoor(t, 2, `{"status":"ALLOWED"}`)
	job := &ClaimedSession{SessionID: "sess-1", Agent: AgentExecConfig{PermissionMode: "default"}}

	allowed := bridgeCodexApproval(context.Background(), NewTransport(url, "tok"), job,
		codexApprovalRequest{}, map[string]interface{}{"itemId": "item_1", "command": "ls"})

	if !allowed {
		t.Fatal("an outage denied a command the owner went on to approve")
	}
	if filed.Load() != 1 || polls.Load() != 3 {
		t.Fatalf("filed %d, polled %d; want one card read through two 502s", filed.Load(), polls.Load())
	}
}

func TestKimiPermissionKeepsReadingTheCardThroughADoorOutage(t *testing.T) {
	fastApprovalRetry(t)
	url, filed, polls := approvalDoor(t, 2, `{"status":"ALLOWED"}`)
	job := &ClaimedSession{SessionID: "sess-1", Agent: AgentExecConfig{PermissionMode: "default"}}

	res := bridgeKimiPermission(context.Background(), NewTransport(url, "tok"), job, map[string]interface{}{
		"toolCall": map[string]interface{}{
			"title": "Bash", "toolCallId": "call_1", "rawInput": map[string]interface{}{"command": "ls"},
		},
		"options": []interface{}{
			map[string]interface{}{"optionId": "approve_once", "kind": "allow_once"},
			map[string]interface{}{"optionId": "reject", "kind": "reject_once"},
		},
	})

	if got := firstString(mapValue(res["outcome"]), "optionId"); got != "approve_once" {
		t.Fatalf("outcome = %#v, want the owner's approval", res)
	}
	if filed.Load() != 1 || polls.Load() != 3 {
		t.Fatalf("filed %d, polled %d; want one card read through two 502s", filed.Load(), polls.Load())
	}
}

// Waiting out an outage must not outlive the session: cancelling it ends the wait at once, even with
// a retry delay far longer than the test.
func TestApprovalWaitThroughAnOutageEndsWithItsContext(t *testing.T) {
	restore := approvalPollRetryDelay
	approvalPollRetryDelay = time.Hour
	t.Cleanup(func() { approvalPollRetryDelay = restore })
	url, _, polls := approvalDoor(t, 1<<30, `{"status":"ALLOWED"}`)
	job := &ClaimedSession{SessionID: "sess-1", Agent: AgentExecConfig{PermissionMode: "default"}}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan bool, 1)

	go func() {
		done <- bridgeCodexApproval(ctx, NewTransport(url, "tok"), job, codexApprovalRequest{},
			map[string]interface{}{"itemId": "item_1", "command": "ls"})
	}()
	deadline := time.Now().Add(5 * time.Second)
	for polls.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	cancel()

	select {
	case allowed := <-done:
		if allowed {
			t.Fatal("a cancelled wait approved the command")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("cancelling the session did not end the wait")
	}
}

// Every reader of an approval waits in awaitApprovalDecision. A loop of its own is where the retry
// went missing before — the create cards had it and the permission prompt did not — so no other
// function may poll a card.
func TestEveryApprovalReaderWaitsInOneLoop(t *testing.T) {
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	funcDecl := regexp.MustCompile(`^func (?:\([^)]*\) )?([A-Za-z0-9_]+)`)
	for _, file := range files {
		if strings.HasSuffix(file, "_test.go") {
			continue
		}
		source, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		enclosing := ""
		for i, line := range strings.Split(string(source), "\n") {
			if m := funcDecl.FindStringSubmatch(line); m != nil {
				enclosing = m[1]
			}
			if strings.Contains(line, ".pollApproval(") && enclosing != "awaitApprovalDecision" {
				t.Errorf("%s:%d: %s polls an approval itself; wait in awaitApprovalDecision instead", file, i+1, enclosing)
			}
		}
	}
}
