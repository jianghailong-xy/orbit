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

// Only the modes whose whole point is being consulted turn approvals on. Don't Ask stays on
// "never" until Codex is handed an allowlist: it is the agent default, and fail-closed with no
// allowlist would deny every command in a task-launched run.
func TestCodexApprovalPolicyPerMode(t *testing.T) {
	for mode, want := range map[string]string{
		"default":           "untrusted",
		"acceptEdits":       "untrusted",
		"plan":              "untrusted",
		"dontAsk":           "never",
		"auto":              "never",
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
